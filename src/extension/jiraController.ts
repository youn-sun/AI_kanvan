// 카드 → Jira 티켓 발급. Jira REST API를 부르고 결과를 카드에 남긴다. 형식 판단은 core/jira가 한다.
// 계정 이메일과 API 토큰은 기기마다 VS Code 비밀 저장소에 둔다. board.json에는 사이트와 프로젝트만 둔다.

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  blocking,
  draftFromDocs,
  issuePayload,
  lintTicket,
  normalizeSite,
  parseIssues,
  parseIssueTypes,
  parseTypeFields,
  ticketSummary,
  type JiraIssueRef,
  type JiraIssueType,
  type JiraSettings,
  type TicketDraft,
} from '../core/jira';
import { approvalState } from '../core/approval';
import type { Card } from '../core/types';
import type { ToExtension } from '../shared/protocol';
import type { BoardController } from './boardController';

const EMAIL = 'agentBoard.jira.email';
const TOKEN = 'agentBoard.jira.token';
const TIMEOUT_MS = 20000;
const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens';

class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 요청은 보냈지만 응답을 받지 못했다. 서버에서 만들어졌을 수 있다. */
class JiraNoResponse extends Error {}

type Credentials = { email: string; token: string };

export class JiraController {
  /** 연결한 계정 이메일. 상태 화면에 보여 준다 */
  account?: string;
  private typeCache?: { key: string; types: JiraIssueType[] };

  constructor(
    private readonly board: BoardController,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  async init(): Promise<void> {
    this.account = (await this.secrets.get(TOKEN)) ? await this.secrets.get(EMAIL) : undefined;
  }

  async handle(msg: ToExtension): Promise<boolean> {
    switch (msg.type) {
      case 'jiraConnect':
        await this.connect();
        return true;
      case 'jiraDisconnect':
        await this.secrets.delete(TOKEN);
        await this.secrets.delete(EMAIL);
        this.account = undefined;
        this.board.refresh();
        return true;
      case 'jiraDraft':
        await this.draft(msg.dir);
        return true;
      case 'jiraCreate':
        await this.create(msg.dir, msg.draft);
        return true;
      case 'jiraLink':
        await this.link(msg.dir, msg.key.trim().toUpperCase());
        return true;
      case 'jiraUnlink':
        await this.link(msg.dir, undefined);
        return true;
      default:
        return false;
    }
  }

  private settings(): JiraSettings | undefined {
    const s = this.board.jiraSettings();
    return s?.site.trim() && s.projectKey.trim() ? s : undefined;
  }

  private async credentials(): Promise<Credentials | undefined> {
    const [email, token] = await Promise.all([this.secrets.get(EMAIL), this.secrets.get(TOKEN)]);
    return email && token ? { email, token } : undefined;
  }

  private async request(settings: JiraSettings, creds: Credentials, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`https://${normalizeSite(settings.site)}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new JiraNoResponse(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const json: unknown = text ? safeJson(text) : undefined;
    if (!res.ok) throw new JiraHttpError(res.status, errorText(res.status, json, text));
    return json;
  }

  /** 이메일·토큰을 받아 Jira에 실제로 로그인되는지 확인한 뒤에 저장한다. */
  private async connect(): Promise<void> {
    const settings = this.settings();
    if (!settings) {
      void vscode.window.showWarningMessage(this.board.t('jira.needSettings'));
      return;
    }
    const email = await vscode.window.showInputBox({
      title: this.board.t('jira.connectTitle'),
      prompt: this.board.t('jira.emailPrompt'),
      value: this.account ?? '',
      ignoreFocusOut: true,
    });
    if (!email?.trim()) return;
    const token = await vscode.window.showInputBox({
      title: this.board.t('jira.connectTitle'),
      prompt: this.board.t('jira.tokenPrompt', { url: TOKEN_PAGE }),
      password: true,
      ignoreFocusOut: true,
    });
    if (!token?.trim()) return;
    const creds = { email: email.trim(), token: token.trim() };
    try {
      await this.request(settings, creds, 'GET', '/rest/api/3/myself');
    } catch (err) {
      void vscode.window.showErrorMessage(this.board.t('jira.connectFailed', { error: (err as Error).message }));
      return;
    }
    await this.secrets.store(EMAIL, creds.email);
    await this.secrets.store(TOKEN, creds.token);
    this.account = creds.email;
    this.typeCache = undefined;
    void vscode.window.showInformationMessage(this.board.t('jira.connected', { email: creds.email }));
    this.board.refresh();
  }

  /** 업무 유형과 유형마다 꼭 골라야 하는 선택 필드. 사이트·프로젝트가 같으면 다시 묻지 않는다. */
  private async issueTypes(settings: JiraSettings, creds: Credentials): Promise<JiraIssueType[]> {
    const key = `${normalizeSite(settings.site)}/${settings.projectKey}`;
    if (this.typeCache?.key === key) return this.typeCache.types;
    const base = `/rest/api/3/issue/createmeta/${encodeURIComponent(settings.projectKey.trim())}/issuetypes`;
    const list = parseIssueTypes(await this.request(settings, creds, 'GET', `${base}?maxResults=50`));
    const types = await Promise.all(
      list.map(async (t) => ({
        ...t,
        fields: parseTypeFields(await this.request(settings, creds, 'GET', `${base}/${encodeURIComponent(t.id)}?maxResults=200`)),
      })),
    );
    this.typeCache = { key, types };
    return types;
  }

  private async recentIssues(settings: JiraSettings, creds: Credentials, jql: string): Promise<JiraIssueRef[]> {
    const q = new URLSearchParams({ jql, fields: 'summary,status', maxResults: '100' });
    return parseIssues(await this.request(settings, creds, 'GET', `/rest/api/3/search/jql?${q.toString()}`));
  }

  private projectJql(settings: JiraSettings): string {
    return `project = "${settings.projectKey.trim().replace(/"/g, '')}"`;
  }

  /** 카드 문서로 초안을 만들고, 유형·필드와 중복 검사용 최근 티켓을 함께 보낸다. */
  private async draft(dir: string): Promise<void> {
    const settings = this.settings();
    const creds = await this.credentials();
    const card = await this.board.freshCardOf(dir);
    if (!settings || !creds || !card) {
      this.board.post({ type: 'jiraDraft', dir, error: this.board.t(!settings ? 'jira.needSettings' : 'jira.needAccount') });
      return;
    }
    if (!(await this.approved(dir, card))) {
      this.board.post({ type: 'jiraDraft', dir, error: this.board.t('jira.notApproved') });
      return;
    }
    try {
      const [types, recent, intent, spec] = await Promise.all([
        this.issueTypes(settings, creds),
        this.recentIssues(settings, creds, `${this.projectJql(settings)} ORDER BY created DESC`),
        this.board.repo.readTaskDoc(dir, 'intent'),
        this.board.repo.readTaskDoc(dir, 'spec'),
      ]);
      const type = types.find((t) => /^(작업|task)$/i.test(t.name)) ?? types[0];
      const draft: TicketDraft = {
        typeId: type?.id ?? '',
        fieldValues: {},
        notes: '',
        review: false,
        deploy: false,
        ...draftFromDocs(card.title, intent, spec),
      };
      this.board.post({ type: 'jiraDraft', dir, draft, types, recent });
    } catch (err) {
      this.board.post({ type: 'jiraDraft', dir, error: (err as Error).message });
    }
  }

  private async create(dir: string, draft: TicketDraft): Promise<void> {
    const settings = this.settings();
    const creds = await this.credentials();
    const card = await this.board.freshCardOf(dir);
    if (!settings || !creds || !card) return this.result(dir, { error: this.board.t(!settings ? 'jira.needSettings' : 'jira.needAccount') });
    if (card.jira) return this.result(dir, { error: this.board.t('jira.alreadyLinked', { key: card.jira.key }) });
    // 보내기 직전에 디스크의 카드와 문서로 승인을 다시 확인한다. 승인한 뒤 문서가 바뀌었으면 보내지 않는다.
    if (!(await this.approved(dir, card))) return this.result(dir, { error: this.board.t('jira.notApproved') });
    let types: JiraIssueType[];
    try {
      types = await this.issueTypes(settings, creds);
    } catch (err) {
      return this.result(dir, { error: (err as Error).message });
    }
    // 화면에서 검사했더라도 보내기 직전에 같은 규칙으로 다시 검사한다.
    if (blocking(lintTicket(draft, types))) return this.result(dir, { error: this.board.t('jira.lintBlocked') });

    const post = (tasks: boolean) => this.request(settings, creds, 'POST', '/rest/api/3/issue', issuePayload(draft, settings, types, randomUUID, tasks));
    let created: { key?: string } | undefined;
    try {
      try {
        created = (await post(true)) as { key?: string };
      } catch (err) {
        // 400은 만들어지지 않았다는 뜻이다. 체크리스트를 받지 않는 Jira면 글머리 목록으로 한 번 더 보낸다.
        if (!(err instanceof JiraHttpError && err.status === 400 && /description/i.test(err.message))) throw err;
        created = (await post(false)) as { key?: string };
      }
    } catch (err) {
      if (err instanceof JiraNoResponse) return this.recover(dir, draft, settings, creds);
      return this.result(dir, { error: (err as Error).message });
    }
    if (!created?.key) return this.result(dir, { error: this.board.t('jira.noKey') });
    await this.link(dir, created.key);
    void vscode.window.showInformationMessage(this.board.t('jira.created', { key: created.key }));
    this.result(dir, { key: created.key });
  }

  /** 응답을 받지 못했으면 다시 만들지 않고, 방금 내가 만든 같은 제목의 티켓이 있는지 찾는다. */
  private async recover(dir: string, draft: TicketDraft, settings: JiraSettings, creds: Credentials): Promise<void> {
    const summary = ticketSummary(draft);
    try {
      const mine = await this.recentIssues(settings, creds, `${this.projectJql(settings)} AND reporter = currentUser() AND created >= -30m ORDER BY created DESC`);
      const found = mine.find((i) => i.summary === summary);
      if (found) {
        await this.link(dir, found.key);
        return this.result(dir, { key: found.key });
      }
    } catch {
      // 확인도 못 하면 아래처럼 사람이 확인하게 한다.
    }
    this.result(dir, { error: this.board.t('jira.uncertain'), uncertain: true });
  }

  private async approved(dir: string, card: Card): Promise<boolean> {
    return approvalState(card.approval, await this.board.repo.docsHash(dir)) === 'approved';
  }

  private result(dir: string, r: { key?: string; error?: string; uncertain?: boolean }): void {
    this.board.post({ type: 'jiraResult', dir, ...r });
  }

  /** 기존 티켓에 연결하거나(key) 연결을 끊는다(undefined). */
  private async link(dir: string, key: string | undefined): Promise<void> {
    if (key !== undefined && !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
      void vscode.window.showWarningMessage(this.board.t('jira.badKey'));
      return;
    }
    const card = await this.board.freshCardOf(dir);
    if (!card) return;
    const next = { ...card, updatedAt: new Date().toISOString() };
    if (key) next.jira = { key };
    else delete next.jira;
    await this.board.saveCard(next);
  }

}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Jira 오류 응답에서 사람이 읽을 메시지를 꺼낸다. 토큰 같은 요청 내용은 넣지 않는다. */
function errorText(status: number, json: unknown, text: string): string {
  const j = (json ?? {}) as { errorMessages?: string[]; errors?: Record<string, string>; message?: string };
  const parts = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`), ...(j.message ? [j.message] : [])];
  return `Jira ${status}: ${parts.join(' / ') || text.slice(0, 200) || 'no detail'}`;
}
