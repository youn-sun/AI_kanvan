// 보드를 브라우저에서 연다. 웹뷰와 같은 메시지를 HTTP(요청)와 SSE(응답)로 주고받는다.
// 127.0.0.1에서만 듣고, 주소의 토큰이 맞는 요청만 받는다.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { Locale } from '../shared/i18n';
import type { ToExtension, ToWebview } from '../shared/protocol';

const MAX_BODY = 50 * 1024 * 1024;

interface Saved {
  port?: number;
  token?: string;
}

export class BoardWebServer {
  private server?: http.Server;
  private token = '';
  private readonly clients = new Set<http.ServerResponse>();
  private lastState?: ToWebview;

  constructor(
    private readonly distDir: string,
    private readonly locale: Locale,
    /** 포트·토큰을 남겨 두는 파일. 다시 켜도 같은 주소(북마크)를 쓴다. */
    private readonly savedFile: string,
    private readonly handle: (msg: ToExtension) => Promise<void>,
  ) {}

  async start(): Promise<string> {
    if (!this.server) {
      const saved = await readSaved(this.savedFile);
      this.token = saved.token ?? randomBytes(16).toString('hex');
      const server = http.createServer((req, res) => {
        this.route(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      const port = await listen(server, saved.port ?? 0).catch(() => listen(server, 0));
      this.server = server;
      await fs.mkdir(path.dirname(this.savedFile), { recursive: true });
      await fs.writeFile(this.savedFile, JSON.stringify({ port, token: this.token }));
    }
    return `http://127.0.0.1:${this.port()}/?t=${this.token}`;
  }

  post(msg: ToWebview): void {
    if (msg.type === 'state') this.lastState = msg;
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of this.clients) client.write(data);
  }

  dispose(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.server?.close();
    this.server = undefined;
  }

  private port(): number {
    return (this.server!.address() as AddressInfo).port;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = `http://127.0.0.1:${this.port()}`;
    const url = new URL(req.url ?? '/', origin);
    // Host 검사로 DNS 리바인딩을, 토큰으로 다른 사이트의 요청을 막는다.
    if (req.headers.host !== `127.0.0.1:${this.port()}` || url.searchParams.get('t') !== this.token) {
      res.writeHead(403).end();
      return;
    }
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(this.html());
        return;
      case 'GET /webview.js':
        return this.sendFile(res, 'webview.js', 'text/javascript; charset=utf-8');
      case 'GET /webview.css':
        return this.sendFile(res, 'webview.css', 'text/css; charset=utf-8');
      case 'GET /events':
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        if (this.lastState) res.write(`data: ${JSON.stringify(this.lastState)}\n\n`);
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      case 'POST /message': {
        if (req.headers.origin && req.headers.origin !== origin) {
          res.writeHead(403).end();
          return;
        }
        const msg = JSON.parse(await readBody(req)) as ToExtension;
        res.writeHead(204).end();
        await this.handle(msg);
        return;
      }
      default:
        res.writeHead(404).end();
    }
  }

  private async sendFile(res: http.ServerResponse, name: string, type: string): Promise<void> {
    const body = await fs.readFile(path.join(this.distDir, name));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  }

  private html(): string {
    const q = `?t=${this.token}`;
    return `<!doctype html>
<html lang="${this.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/webview.css${q}">
<style>${THEME}</style>
<title>Agent Board</title>
</head>
<body>
<div id="root"></div>
<script>
  document.body.className = matchMedia('(prefers-color-scheme: light)').matches ? 'vscode-light' : 'vscode-dark';
  const key = 'agentBoard.viewState';
  window.acquireVsCodeApi = () => ({
    postMessage: (msg) => fetch('/message${q}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }),
    getState: () => JSON.parse(localStorage.getItem(key) || 'null') ?? undefined,
    setState: (s) => localStorage.setItem(key, JSON.stringify(s)),
  });
  new EventSource('/events${q}').onmessage = (e) => window.postMessage(JSON.parse(e.data), location.origin);
</script>
<script src="/webview.js${q}"></script>
</body>
</html>`;
  }
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function readSaved(file: string): Promise<Saved> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Saved;
  } catch {
    return {};
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 웹뷰가 쓰는 VS Code 테마 변수. 브라우저에는 없으므로 기본 다크·라이트 값을 넣는다. */
const THEME = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Consolas, monospace;
  --vscode-editor-font-size: 12px;
  --vscode-charts-blue: #3794ff; --vscode-charts-green: #89d185; --vscode-charts-orange: #d18616;
  --vscode-charts-purple: #b180d7; --vscode-charts-yellow: #cca700;
}
body.vscode-dark {
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d; --vscode-errorForeground: #f85149;
  --vscode-editor-background: #1f1f1f; --vscode-sideBar-background: #181818; --vscode-editorWidget-background: #202020;
  --vscode-editorWidget-border: #454545; --vscode-panel-border: #2b2b2b; --vscode-widget-border: #313131;
  --vscode-menu-background: #1f1f1f; --vscode-textCodeBlock-background: #2b2b2b;
  --vscode-focusBorder: #0078d4; --vscode-textLink-foreground: #4daafc; --vscode-editorWarning-foreground: #cca700;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #026ec1;
  --vscode-button-border: rgba(255, 255, 255, 0.07);
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc; --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-input-background: #313131; --vscode-input-foreground: #cccccc; --vscode-input-border: #3c3c3c;
  --vscode-checkbox-background: #0078d4;
  --vscode-list-activeSelectionBackground: #04395e; --vscode-list-activeSelectionForeground: #ffffff; --vscode-list-hoverBackground: #2a2d2e;
  --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
  --vscode-testing-iconPassed: #73c991; --vscode-testing-iconFailed: #f14c4c;
}
body.vscode-light {
  --vscode-foreground: #3b3b3b; --vscode-descriptionForeground: #717171; --vscode-errorForeground: #f85149;
  --vscode-editor-background: #ffffff; --vscode-sideBar-background: #f8f8f8; --vscode-editorWidget-background: #f8f8f8;
  --vscode-editorWidget-border: #c8c8c8; --vscode-panel-border: #e5e5e5; --vscode-widget-border: #e5e5e5;
  --vscode-menu-background: #ffffff; --vscode-textCodeBlock-background: #f0f0f0;
  --vscode-focusBorder: #005fb8; --vscode-textLink-foreground: #005fb8; --vscode-editorWarning-foreground: #bf8803;
  --vscode-button-background: #005fb8; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #0258a8;
  --vscode-button-border: rgba(0, 0, 0, 0.1);
  --vscode-button-secondaryBackground: #e5e5e5; --vscode-button-secondaryForeground: #3b3b3b; --vscode-button-secondaryHoverBackground: #cccccc;
  --vscode-input-background: #ffffff; --vscode-input-foreground: #3b3b3b; --vscode-input-border: #cecece;
  --vscode-checkbox-background: #005fb8;
  --vscode-list-activeSelectionBackground: #e8e8e8; --vscode-list-activeSelectionForeground: #000000; --vscode-list-hoverBackground: #f2f2f2;
  --vscode-scrollbarSlider-background: rgba(100, 100, 100, 0.4);
  --vscode-testing-iconPassed: #388a34; --vscode-testing-iconFailed: #f14c4c;
}
`;
