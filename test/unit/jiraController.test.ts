import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../../src/core/types';
import { JiraController } from '../../src/extension/jiraController';
import type { BoardController } from '../../src/extension/boardController';
import type { ToWebview } from '../../src/shared/protocol';
import type { TicketDraft } from '../../src/core/jira';
import { stub } from '../stubs/vscode';

type Call = { method: string; url: string; body?: unknown; auth?: string };
type Reply = { status: number; json?: unknown } | 'no-response';

/** 경로 → 응답. 같은 경로를 여러 번 부르면 배열의 다음 응답을 쓴다. */
function fakeJira(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push({ method: init.method, url: `${u.pathname}${u.search}`, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    const route = routes[key];
    const reply = Array.isArray(route) ? route.shift() : route;
    if (!reply) return new Response('{}', { status: 404 });
    if (reply === 'no-response') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status });
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

const META = {
  'GET /rest/api/3/issue/createmeta/FDE/issuetypes': { status: 200, json: { issueTypes: [{ id: '11323', name: '작업' }, { id: '11324', name: '버그' }] } },
  'GET /rest/api/3/issue/createmeta/FDE/issuetypes/11323': {
    status: 200,
    json: { fields: [{ fieldId: 'customfield_10485', name: '업무 구분', required: true, schema: { type: 'option' }, allowedValues: [{ id: '10341', value: '기능 추가' }] }] },
  },
  'GET /rest/api/3/issue/createmeta/FDE/issuetypes/11324': { status: 200, json: { fields: [] } },
};

const draft: TicketDraft = {
  typeId: '11323',
  fieldValues: { customfield_10485: '10341' },
  service: 'SA 대시보드',
  title: 'CSV 다운로드 추가',
  background: '보고서 작성에 쓴다.',
  todo: 'CSV로 내려받게 한다.',
  criteria: '파일 내용이 조회 조건과 같다.',
  notes: '',
  review: false,
  deploy: false,
};

function setup(card: Partial<Card> = {}, docsHash = 'HASH') {
  const secrets = new Map<string, string>([
    ['agentBoard.jira.email', 'me@example.com'],
    ['agentBoard.jira.token', 'TOKEN'],
  ]);
  let saved: Card = { id: 'TASK-1', title: 'CSV 다운로드 추가', approval: { at: '2026-11-05T00:00:00.000Z', hash: 'HASH' }, ...card } as Card;
  const posted: ToWebview[] = [];
  const board = {
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    post: (m: ToWebview) => posted.push(m),
    refresh: () => undefined,
    findCard: () => saved,
    freshCardOf: async () => saved,
    saveCard: async (c: Card) => void (saved = c),
    jiraSettings: () => ({ site: 'https://team.atlassian.net/jira', projectKey: 'FDE' }),
    repo: {
      docsHash: async () => docsHash,
      readTaskDoc: async (_: string, doc: string) =>
        doc === 'intent' ? '## 목적\n보고서 작성에 쓴다.\n' : '## 요구사항\nCSV로 내려받게 한다.\n\n## 완료 조건\n- 파일 내용이 조회 조건과 같다.\n',
    },
  } as unknown as BoardController;
  const store = {
    get: async (k: string) => secrets.get(k),
    store: async (k: string, v: string) => void secrets.set(k, v),
    delete: async (k: string) => void secrets.delete(k),
  };
  const jira = new JiraController(board, store as never);
  return { jira, posted, secrets, card: () => saved };
}

beforeEach(() => {
  stub.answers = [];
  stub.messages = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('JiraController', () => {
  it('sends a draft built from the card documents with types, fields and recent tickets', async () => {
    const calls = fakeJira({ ...META, 'GET /rest/api/3/search/jql': { status: 200, json: { issues: [{ key: 'FDE-1', fields: { summary: '[SA 대시보드] 입찰 규칙' } }] } } });
    const { jira, posted } = setup();
    await jira.handle({ type: 'jiraDraft', dir: 'TASK-1' });
    expect(posted).toEqual([
      {
        type: 'jiraDraft',
        dir: 'TASK-1',
        draft: { ...draft, fieldValues: {}, service: '' },
        types: [
          { id: '11323', name: '작업', fields: [{ id: 'customfield_10485', name: '업무 구분', options: [{ id: '10341', name: '기능 추가' }] }] },
          { id: '11324', name: '버그', fields: [] },
        ],
        recent: [{ key: 'FDE-1', summary: '[SA 대시보드] 입찰 규칙' }],
      },
    ]);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('me@example.com:TOKEN').toString('base64')}`);
    expect(calls.every((c) => c.url.startsWith('/rest/api/3/'))).toBe(true);
  });

  it('creates the ticket and links it to the card', async () => {
    const calls = fakeJira({ ...META, 'POST /rest/api/3/issue': { status: 201, json: { key: 'FDE-16' } } });
    const { jira, posted, card } = setup();
    await jira.handle({ type: 'jiraCreate', dir: 'TASK-1', draft });
    expect(card().jira).toEqual({ key: 'FDE-16' });
    expect(posted.at(-1)).toEqual({ type: 'jiraResult', dir: 'TASK-1', key: 'FDE-16' });
    const body = calls.find((c) => c.method === 'POST')!.body as { fields: Record<string, unknown> };
    expect(body.fields).toMatchObject({ summary: '[SA 대시보드] CSV 다운로드 추가', customfield_10485: { id: '10341' } });
  });

  it('does not send a ticket that fails the format check or a card that is already linked', async () => {
    const calls = fakeJira(META);
    const { jira, posted } = setup();
    await jira.handle({ type: 'jiraCreate', dir: 'TASK-1', draft: { ...draft, fieldValues: {} } });
    expect(posted.at(-1)).toEqual({ type: 'jiraResult', dir: 'TASK-1', error: 'jira.lintBlocked' });

    const linked = setup({ jira: { key: 'FDE-3' } });
    await linked.jira.handle({ type: 'jiraCreate', dir: 'TASK-1', draft });
    expect(linked.posted.at(-1)).toMatchObject({ error: expect.stringContaining('jira.alreadyLinked') });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses to draft or create a ticket for a card that is not approved or changed after approval', async () => {
    const calls = fakeJira({ ...META, 'POST /rest/api/3/issue': { status: 201, json: { key: 'FDE-16' } } });
    for (const s of [setup({ approval: undefined }), setup({}, 'EDITED')]) {
      await s.jira.handle({ type: 'jiraDraft', dir: 'TASK-1' });
      expect(s.posted.at(-1)).toEqual({ type: 'jiraDraft', dir: 'TASK-1', error: 'jira.notApproved' });
      await s.jira.handle({ type: 'jiraCreate', dir: 'TASK-1', draft });
      expect(s.posted.at(-1)).toEqual({ type: 'jiraResult', dir: 'TASK-1', error: 'jira.notApproved' });
      expect(s.card().jira).toBeUndefined();
    }
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    // 기존 티켓에 연결하는 것은 내용을 보내지 않으므로 승인 없이 할 수 있다.
    const unapproved = setup({ approval: undefined });
    await unapproved.jira.handle({ type: 'jiraLink', dir: 'TASK-1', key: 'FDE-1' });
    expect(unapproved.card().jira).toEqual({ key: 'FDE-1' });
  });

  it('falls back to a plain list when Jira rejects the task list', async () => {
    const calls = fakeJira({
      ...META,
      'POST /rest/api/3/issue': [{ status: 400, json: { errors: { description: 'Operation value must be an Atlassian Document' } } }, { status: 201, json: { key: 'FDE-17' } }],
    });
    const { jira, card } = setup();
    await jira.handle({ type: 'jiraCreate', dir: 'TASK-1', draft });
    const posts = calls.filter((c) => c.method === 'POST').map((c) => JSON.stringify(c.body));
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain('taskList');
    expect(posts[1]).not.toContain('taskList');
    expect(card().jira).toEqual({ key: 'FDE-17' });
  });

  it('does not create again when Jira did not answer, and links the ticket if it was created', async () => {
    const created = { status: 200, json: { issues: [{ key: 'FDE-18', fields: { summary: '[SA 대시보드] CSV 다운로드 추가' } }] } } as const;
    const calls = fakeJira({ ...META, 'POST /rest/api/3/issue': 'no-response', 'GET /rest/api/3/search/jql': created });
    const { jira, card } = setup();
    await jira.handle({ type: 'jiraCreate', dir: 'TASK-1', draft });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(new URL(calls.at(-1)!.url, 'https://x').searchParams.get('jql')).toContain('reporter = currentUser()');
    expect(card().jira).toEqual({ key: 'FDE-18' });

    fakeJira({ ...META, 'POST /rest/api/3/issue': 'no-response', 'GET /rest/api/3/search/jql': { status: 200, json: { issues: [] } } });
    const other = setup();
    await other.jira.handle({ type: 'jiraCreate', dir: 'TASK-1', draft });
    expect(other.card().jira).toBeUndefined();
    expect(other.posted.at(-1)).toEqual({ type: 'jiraResult', dir: 'TASK-1', error: 'jira.uncertain', uncertain: true });
  });

  it('saves the account only after Jira accepts it', async () => {
    fakeJira({ 'GET /rest/api/3/myself': [{ status: 401, json: { message: 'Unauthorized' } }, { status: 200, json: {} }] });
    const { jira, secrets } = setup();
    secrets.clear();
    stub.answers = ['me@example.com', 'BAD'];
    await jira.handle({ type: 'jiraConnect' });
    expect(secrets.size).toBe(0);
    expect(stub.messages.at(-1)).toMatchObject({ level: 'error', text: expect.stringContaining('Jira 401: Unauthorized') });
    stub.answers = ['me@example.com', 'GOOD'];
    await jira.handle({ type: 'jiraConnect' });
    expect(secrets.get('agentBoard.jira.token')).toBe('GOOD');
    expect(jira.account).toBe('me@example.com');
  });

  it('links an existing ticket by key and refuses a malformed key', async () => {
    fakeJira({});
    const { jira, card } = setup();
    await jira.handle({ type: 'jiraLink', dir: 'TASK-1', key: 'fde-15 ' });
    expect(card().jira).toEqual({ key: 'FDE-15' });
    await jira.handle({ type: 'jiraLink', dir: 'TASK-1', key: 'nope' });
    expect(card().jira).toEqual({ key: 'FDE-15' });
    await jira.handle({ type: 'jiraUnlink', dir: 'TASK-1' });
    expect(card().jira).toBeUndefined();
  });
});
