import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardWebServer } from '../../src/extension/webServer';
import type { ToExtension } from '../../src/shared/protocol';

let server: BoardWebServer | undefined;
afterEach(() => server?.dispose());

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-board-web-'));
  await fs.writeFile(path.join(dir, 'webview.js'), 'console.log(1)');
  await fs.writeFile(path.join(dir, 'webview.css'), 'body{}');
  const received: ToExtension[] = [];
  server = new BoardWebServer(dir, 'ko', path.join(dir, 'local', 'web.json'), async (msg) => {
    received.push(msg);
  });
  const url = new URL(await server.start());
  return { dir, url, received };
}

function get(url: URL, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('board in the browser', () => {
  it('serves the board only with the token and the local host name', async () => {
    const { url } = await setup();
    expect((await get(url)).status).toBe(200);
    expect((await get(url)).body).toContain('acquireVsCodeApi');
    expect((await get(new URL(url.pathname, url.origin))).status).toBe(403);
    expect((await get(url, { Host: 'evil.example' })).status).toBe(403);
    expect((await get(new URL(`/webview.js${url.search}`, url.origin))).body).toBe('console.log(1)');
  });

  it('forwards board messages and streams state back', async () => {
    const { url, received } = await setup();
    const res = await fetch(new URL(`/message${url.search}`, url.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ready' }),
    });
    expect(res.status).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([{ type: 'ready' }]);

    const events = await fetch(new URL(`/events${url.search}`, url.origin));
    const reader = events.body!.getReader();
    await reader.read();
    server!.post({ type: 'showSettings' });
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"showSettings"');
    await reader.cancel();
  });

  it('keeps the same address after a restart', async () => {
    const { dir, url } = await setup();
    server!.dispose();
    server = new BoardWebServer(dir, 'ko', path.join(dir, 'local', 'web.json'), async () => {});
    expect(await server.start()).toBe(url.toString());
  });

  it('refuses posts from another origin', async () => {
    const { url, received } = await setup();
    const res = await fetch(new URL(`/message${url.search}`, url.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ type: 'ready' }),
    });
    expect(res.status).toBe(403);
    expect(received).toEqual([]);
  });
});
