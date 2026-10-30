// RunService를 가짜 에이전트 CLI로 끝까지 실행해 본다 (2·3단계 완료 조건).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeAdapter } from '../../src/adapters/claude';
import { progressOf } from '../../src/core/checklist';
import type { RunRecord } from '../../src/core/runs';
import { moveCard } from '../../src/core/status';
import type { Card, Role } from '../../src/core/types';
import { RunService, type BoardAccess } from '../../src/runner/runService';
import { RunStore } from '../../src/runner/runStore';
import { translate } from '../../src/shared/i18n';
import type { ToWebview } from '../../src/shared/protocol';
import { BoardRepository } from '../../src/storage/repository';
import { stub } from '../stubs/vscode';

const FAKE = path.resolve('test/fixtures/fake-agent.mjs');
/** 이 기기에 Cursor CLI가 있어도 테스트에서는 없는 것으로 본다. */
const NO_CLI = path.resolve('test/fixtures/no-such-cli');

class FakeBoard implements BoardAccess {
  readonly cards = new Map<string, Card>();
  readonly posted: ToWebview[] = [];
  maxReviewIterations = 2;
  readonly locale = 'en' as const;
  constructor(readonly repo: BoardRepository) {}
  get root() {
    return this.repo.root;
  }
  t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params);
  getCard = (id: string) => this.cards.get(id);
  allCards = () => [...this.cards.values()];
  saveCard = async (card: Card) => {
    if (!this.staleNewCards || this.cards.has(card.id)) this.cards.set(card.id, card);
    await this.repo.saveCard(card);
  };
  progress = async (id: string) => progressOf(await this.repo.readTaskDoc(id, 'plan'));
  enabled: ('claude' | 'codex' | 'cursor')[] = ['claude', 'codex', 'cursor'];
  settings = () => ({ maxReviewIterations: this.maxReviewIterations, stopTimeoutSec: 2, defaultAutoReview: false });
  enabledTools = () => this.enabled;
  sharedDocs = () => [];
  taskDocPath = (id: string, doc: 'intent' | 'spec' | 'plan') => this.repo.taskDocPath(id, doc);
  moveByUser = async (id: string, to: Card['status']) => {
    const r = moveCard(this.cards.get(id)!, to, { now: new Date().toISOString(), hasActiveRun: false });
    await this.saveCard(r.card);
  };
  /** 실제 보드처럼 새 카드가 다음 reload 전까지 getCard에 보이지 않게 한다. */
  staleNewCards = false;
  createCard = async (title: string) => {
    const order = Math.max(0, ...[...this.cards.values()].map((c) => c.order)) + 1;
    const card = await this.repo.createCard({ title }, order);
    if (!this.staleNewCards) this.cards.set(card.id, card);
    return card;
  };
  refresh = () => undefined;
  post = (msg: ToWebview) => void this.posted.push(msg);
}

let tmp: string;
let state: string;
let repo: BoardRepository;
let board: FakeBoard;
let service: RunService;

async function waitFor<T>(fn: () => T | Promise<T>, timeout = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function runsOf(cardId: string): Promise<RunRecord[]> {
  return (await new RunStore(repo.localDir).loadRuns()).runs.filter((r) => r.cardId === cardId);
}

async function newCard(agents: Partial<Record<Role, 'claude'>>, plan = '- [ ] one\n'): Promise<Card> {
  const card = await repo.createCard({ title: 'Login' }, 1);
  const withAgents: Card = {
    ...card,
    agents: Object.fromEntries(Object.entries(agents).map(([r, tool]) => [r, { tool }])),
  };
  await board.saveCard(withAgents);
  await repo.writeTaskDoc(card.id, 'plan', plan);
  return withAgents;
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-board-svc-')));
  const root = path.join(tmp, 'repo');
  state = path.join(tmp, 'fake');
  await fs.mkdir(root);
  await fs.mkdir(state);
  await fs.writeFile(path.join(state, 'verdicts.json'), '[]');
  process.env.FAKE_STATE = state;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  await fs.writeFile(path.join(root, 'README.md'), 'x');
  git('add', '.');
  git('commit', '-qm', 'init');
  repo = new BoardRepository(root, 'en');
  await repo.init();
  board = new FakeBoard(repo);
  service = new RunService(board, new RunStore(repo.localDir), path.resolve('dist/hook.js'), () => ({ claude: FAKE, cursor: NO_CLI }));
  await service.init();
  stub.answers = [];
  stub.messages = [];
  stub.commands.clear();
  stub.executed = [];
  stub.terminals = [];
});

afterEach(async () => {
  service.dispose();
  // 회차 종료 후 정리 작업이 남아 있을 수 있어 삭제를 재시도한다.
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('RunService with a fake agent', () => {
  it('detects tools and their capabilities (T-3, E-4)', () => {
    const claude = service.tools().find((t) => t.id === 'claude')!;
    expect(claude).toMatchObject({ installed: true, version: '9.9.9 (Fake)' });
    expect(service.tools().find((t) => t.id === 'cursor')!.capabilities.readOnly).toBe(false);
  });

  it('runs the implementer in the card worktree and records the run (E-1, E-2, W-1)', async () => {
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    // 종료 후 변경 사항 수집(afterRun)까지 기다린다.
    const run = await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'ended' && r.diff !== undefined));

    const worktree = path.resolve(repo.root, '../repo-worktrees/TASK-1');
    expect(board.getCard(card.id)!.workspace).toEqual({ branch: 'task/TASK-1', worktree: '../repo-worktrees/TASK-1' });
    expect(run.summary).toContain('Implemented');
    expect(run.verification).toBe('fake tests passed');
    expect(run.changes?.some((f) => f.startsWith('impl-'))).toBe(true);
    expect(run.diff).toBeDefined();
    expect(run.toolSessionId).toBeDefined();
    expect(existsSync(run.transcriptPath!)).toBe(true);
    expect(Object.keys(run.inputVersions)).toEqual(
      expect.arrayContaining(['.agent-board/tasks/TASK-1/plan.md', '.agent-board/tasks/TASK-1/spec.md']),
    );
    // P-5: 에이전트가 plan.md 항목을 체크했다.
    expect(await board.progress(card.id)).toEqual({ done: 1, total: 1 });

    const calls = await Promise.all(
      (await fs.readdir(state)).filter((f) => f.startsWith('call-')).map(async (f) => JSON.parse(await fs.readFile(path.join(state, f), 'utf8'))),
    );
    expect(calls[0].cwd).toBe(worktree);
    expect(calls[0].env).toEqual({ run: '1', card: 'TASK-1' });

    const view = await service.runs(card.id);
    expect(view.sessions.implementer).toContain(run.toolSessionId);
    // M-4: 실행 후 문서가 바뀌면 표시된다.
    expect(view.runs[0]!.inputChanged).toBe(true);
  });

  it('resumes the bound session (E-5)', async () => {
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    const first = await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'ended' && r.diff !== undefined));
    await service.startRun(card.id, 'implementer', { resume: true });
    const second = await waitFor(async () => (await runsOf(card.id)).find((r) => r.runId === '2' && r.status === 'ended' && r.diff !== undefined));
    expect(second.toolSessionId).toBe(first.toolSessionId);
  });

  it('marks failures as error with stderr (R-1)', async () => {
    await fs.writeFile(path.join(state, 'mode'), 'fail');
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    const run = await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'error'));
    expect(run.statusDetail).toContain('fake failure');
  });

  it('stops a running agent (6.1, R-2)', async () => {
    await fs.writeFile(path.join(state, 'mode'), 'hang');
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'running' && r.toolSessionId));
    expect(service.hasActiveRun(card.id)).toBe(true);
    await service.stopAll(board.getCard(card.id)!);
    await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'stopped'));
    expect(service.hasActiveRun(card.id)).toBe(false);
  });

  it('shows the real result when the agent exits after the stop timeout (R-2, 6.1)', async () => {
    await fs.writeFile(path.join(state, 'mode'), 'slowstop');
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    // 에이전트의 첫 출력을 받은 뒤(신호 처리기 등록 후)에 중단한다.
    await waitFor(async () => (await runsOf(card.id)).find((r) => r.lastSeq.stream !== undefined));
    await service.stopRun(card.id, 'implementer');
    expect(service.runStatus(card.id)).toEqual({ implementer: 'unknown' });
    await waitFor(() => service.runStatus(card.id).implementer === 'stopped');
  });

  it('starts only one run on repeated clicks (spec 7)', async () => {
    await fs.writeFile(path.join(state, 'mode'), 'hang');
    const card = await newCard({ implementer: 'claude' });
    await Promise.all([
      service.startRun(card.id, 'implementer', { resume: false }),
      service.startRun(card.id, 'implementer', { resume: false }),
    ]);
    expect(service.hasActiveRun(card.id)).toBe(true);
    expect((await runsOf(card.id)).length).toBe(1);
    await service.stopAll(board.getCard(card.id)!);
  });

  it('passes review and completes the card automatically (K-2)', async () => {
    const card = await newCard({ implementer: 'claude', reviewer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'ended'));
    await fs.writeFile(path.join(state, 'verdicts.json'), JSON.stringify([{ verdict: 'pass', findings: [] }]));
    await service.handle({ type: 'requestReview', dir: card.id });
    const review = await waitFor(async () => (await runsOf(card.id)).find((r) => r.role === 'reviewer' && r.review));
    expect(review.reviewedRef).toMatch(/^[0-9a-f]{40}/);
    await waitFor(() => board.getCard(card.id)!.status === 'done');
    expect(service.reviewSummary(card.id)).toEqual({ lastPassed: true, rereviewRequired: false });

    // A-5: 리뷰 후 코드가 바뀌면 재리뷰 필요
    await fs.writeFile(path.resolve(repo.root, '../repo-worktrees/TASK-1/late.txt'), 'late');
    await service.refreshCodeRefs();
    expect(service.reviewSummary(card.id).rereviewRequired).toBe(true);
  });

  it('moves the card to In Progress and then Review as the implementer finishes the checklist (K-4)', async () => {
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'ended' && r.diff !== undefined));
    await waitFor(() => board.getCard(card.id)!.status === 'review');

    // 체크리스트가 남아 있으면 In Progress에 머문다.
    const partial = await newCard({ implementer: 'claude' }, '- [ ] one\n- [ ] two\n');
    await service.startRun(partial.id, 'implementer', { resume: false });
    await waitFor(async () => (await runsOf(partial.id)).find((r) => r.status === 'ended' && r.diff !== undefined));
    expect(board.getCard(partial.id)!.status).toBe('in_progress');
  });

  it('moves cards for sessions started outside the board, without overriding the user (K-3, K-4)', async () => {
    const card = await newCard({ implementer: 'claude' }, '- [ ] one\n');
    await service.handle({ type: 'createWorktree', dir: card.id });
    const cwd = path.resolve(repo.root, board.getCard(card.id)!.workspace!.worktree!);
    const inbox = new RunStore(repo.localDir).inboxDir;
    await fs.mkdir(inbox, { recursive: true });
    let n = 0;
    const hook = async (input: Record<string, unknown>) => {
      n += 1;
      const name = `${String(n).padStart(15, '0')}-k`;
      await fs.writeFile(path.join(inbox, `${name}.json`), JSON.stringify({ tool: 'claude', receivedAt: new Date().toISOString(), input: { session_id: 'EXT', cwd, ...input } }));
      await service.processInbox();
    };
    const status = () => board.getCard(card.id)!.status;

    await hook({ hook_event_name: 'SessionStart' });
    expect(status()).toBe('todo');
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'start' });
    expect(status()).toBe('in_progress');

    // 요청 처리 중에 사용자가 카드를 옮기면 그 요청의 끝에서는 옮기지 않는다.
    await board.moveByUser(card.id, 'todo');
    await board.moveByUser(card.id, 'in_progress');
    await repo.writeTaskDoc(card.id, 'plan', '- [x] one\n');
    await hook({ hook_event_name: 'Stop' });
    expect(status()).toBe('in_progress');

    // 다음 요청부터는 다시 자동으로 옮긴다. 리뷰어가 없으면 Review에 머문다.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' });
    await hook({ hook_event_name: 'Stop' });
    expect(status()).toBe('review');
  });

  it('loops fix → re-review and stops at the iteration limit (A-6, A-7)', async () => {
    const card = await newCard({ implementer: 'claude', reviewer: 'claude' }, '- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n');
    await board.saveCard({ ...board.getCard(card.id)!, autoReview: true });
    const cr = (m: string) => ({ verdict: 'changes_requested', findings: [{ file: 'a.ts', line: 1, message: m }] });
    await fs.writeFile(path.join(state, 'verdicts.json'), JSON.stringify([cr('one'), cr('two'), cr('three')]));
    await service.handle({ type: 'requestReview', dir: card.id });
    const limited = await waitFor(
      async () => (await runsOf(card.id)).find((r) => r.role === 'reviewer' && r.status === 'input_required'),
      15000,
    );
    const runs = await runsOf(card.id);
    expect(runs.map((r) => `${r.role[0]}${r.loopIteration ?? 0}`)).toEqual(['r0', 'i1', 'r1', 'i2', 'r2']);
    expect(limited.statusDetail).toContain('2 iterations');
    expect(board.getCard(card.id)!.status).toBe('review');
    // 수정 회차는 구현자 세션을 이어서 실행한다.
    const fixes = runs.filter((r) => r.role === 'implementer');
    expect(fixes[1]!.toolSessionId).toBe(fixes[0]!.toolSessionId);
  }, 20000);

  it('stops the loop when the reviewer repeats the same findings (A-7)', async () => {
    const card = await newCard({ implementer: 'claude', reviewer: 'claude' });
    await board.saveCard({ ...board.getCard(card.id)!, autoReview: true });
    const same = { verdict: 'changes_requested', findings: [{ message: 'same thing' }] };
    await fs.writeFile(path.join(state, 'verdicts.json'), JSON.stringify([same, same]));
    await service.handle({ type: 'requestReview', dir: card.id });
    const stopped = await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'input_required'), 15000);
    expect(stopped.statusDetail).toContain('same findings');
    expect((await runsOf(card.id)).length).toBe(3);
  }, 20000);
});

describe('recovery and sessions', () => {
  it('marks a run whose process vanished as unknown (V-1, V-2)', async () => {
    const card = await newCard({ implementer: 'claude' });
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.once('exit', r));
    const store = new RunStore(repo.localDir);
    const now = new Date().toISOString();
    await store.saveRuns({
      runs: [
        {
          runId: '1', cardId: card.id, role: 'implementer', tool: 'claude', status: 'running', startedAt: now,
          inputVersions: {}, lastSeenAt: now, lastSeq: {}, statusVersionAtStart: 0, process: { pid: child.pid!, startedAt: now },
        },
      ],
      seenEventIds: [],
    });
    const restarted = new RunService(board, store, '', () => ({ claude: FAKE }));
    await restarted.init();
    expect(restarted.runStatus(card.id)).toEqual({ implementer: 'unknown' });
    await restarted.handle({ type: 'resolveRun', dir: card.id, runId: '1', status: 'ended' });
    expect(restarted.runStatus(card.id)).toEqual({ implementer: 'ended' });
    restarted.dispose();
  });

  it('does not lose run history when hook events arrive before init', async () => {
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'ended' && r.diff !== undefined));
    const store = new RunStore(repo.localDir);
    await fs.mkdir(store.inboxDir, { recursive: true });
    await fs.writeFile(
      path.join(store.inboxDir, '000000000000009-z.json'),
      JSON.stringify({ tool: 'claude', receivedAt: new Date().toISOString(), input: { hook_event_name: 'Stop', session_id: 'X' } }),
    );
    const restarted = new RunService(board, store, '', () => ({ claude: FAKE }));
    await restarted.beforeReload(); // init 전 reload
    expect(await restarted.handle({ type: 'loadRuns', dir: card.id })).toBe(false);
    await restarted.init();
    expect((await runsOf(card.id)).length).toBe(1);
    expect(restarted.runStatus(card.id)).toEqual({ implementer: 'ended' });
    restarted.dispose();
  });

  it('links hook events from sessions started in a card worktree (E-8)', async () => {
    const card = await newCard({ implementer: 'claude' });
    await service.handle({ type: 'createWorktree', dir: card.id });
    const worktree = path.resolve(repo.root, board.getCard(card.id)!.workspace!.worktree!);
    const inbox = new RunStore(repo.localDir).inboxDir;
    await fs.mkdir(inbox, { recursive: true });
    const write = (name: string, input: unknown) =>
      fs.writeFile(path.join(inbox, `${name}.json`), JSON.stringify({ tool: 'claude', receivedAt: new Date().toISOString(), input }));
    await write('000000000000001-a', { hook_event_name: 'SessionStart', session_id: 'EXT', cwd: path.join(worktree, 'src') });
    await write('000000000000002-b', { hook_event_name: 'Notification', session_id: 'EXT', notification_type: 'permission_prompt' });
    await write('000000000000003-c', { hook_event_name: 'SessionStart', session_id: 'LOST', cwd: '/somewhere/else' });
    await service.processInbox();
    expect(service.runStatus(card.id)).toEqual({ implementer: 'input_required' });
    expect((await runsOf(card.id))[0]).toMatchObject({ external: true, toolSessionId: 'EXT' });
    expect(service.unlinkedSessions()).toEqual([{ tool: 'claude', sessionId: 'LOST', cwd: '/somewhere/else' }]);
    expect(await fs.readdir(inbox)).toEqual([]);

    // 이미 세션이 있는 역할은 손으로 연 다른 세션에 빼앗기지 않는다.
    await write('000000000000004-d', { hook_event_name: 'SessionStart', session_id: 'HAND', cwd: worktree });
    await service.processInbox();
    expect((await runsOf(card.id)).filter((r) => r.toolSessionId === 'HAND')).toEqual([]);
    expect(service.unlinkedSessions().map((u) => u.sessionId)).toContain('HAND');

    // 다른 카드에 같은 세션을 연결할 수 없다 (E-6).
    const other = await newCard({ implementer: 'claude' });
    stub.answers = [{ label: other.id }, { role: 'implementer' }];
    await service.handle({ type: 'linkSession', tool: 'claude', sessionId: 'EXT' });
    expect(stub.messages.some((m) => m.text.includes('already bound to TASK-1'))).toBe(true);

    // 끝난 세션을 다시 이어 쓰면 새 회차로 기록되어 입력 필요 표시가 다시 뜬다.
    await write('000000000000005-e', { hook_event_name: 'SessionEnd', session_id: 'EXT' });
    await service.processInbox();
    expect(service.runStatus(card.id)).toEqual({ implementer: 'ended' });
    await write('000000000000006-f', { hook_event_name: 'UserPromptSubmit', session_id: 'EXT', prompt: '이어서' });
    await write('000000000000007-g', { hook_event_name: 'Stop', session_id: 'EXT' });
    await service.processInbox();
    expect(service.runStatus(card.id)).toEqual({ implementer: 'input_required' });
    expect((await runsOf(card.id)).filter((r) => r.toolSessionId === 'EXT').length).toBe(2);
  });
  it('sends later events of a session picked for another card to that card (pickSession)', async () => {
    const first = await newCard({ implementer: 'claude' });
    const second = await newCard({ implementer: 'claude' });
    const inbox = new RunStore(repo.localDir).inboxDir;
    await fs.mkdir(inbox, { recursive: true });
    const write = (name: string, input: unknown) =>
      fs.writeFile(path.join(inbox, `${name}.json`), JSON.stringify({ tool: 'claude', receivedAt: new Date().toISOString(), input }));
    stub.answers = [{ label: first.id }, { role: 'implementer' }];
    await service.handle({ type: 'linkSession', tool: 'claude', sessionId: 'MOVE' });
    await write('000000000000001-a', { hook_event_name: 'UserPromptSubmit', session_id: 'MOVE', prompt: 'first' });
    await service.processInbox();

    // 이전 카드에서 연결을 풀고, 다음 카드에서 같은 세션을 고른다.
    await service.handle({ type: 'newSession', dir: first.id, role: 'implementer' });
    const spy = vi.spyOn(claudeAdapter, 'listSessions').mockResolvedValue([{ id: 'MOVE', updatedAt: new Date().toISOString() }]);
    stub.answers = [{ label: 'MOVE' }];
    await service.handle({ type: 'pickSession', dir: second.id, role: 'implementer' });
    spy.mockRestore();
    await write('000000000000002-b', { hook_event_name: 'Stop', session_id: 'MOVE', last_assistant_message: '두 번째 카드 작업' });
    await service.processInbox();

    const [old] = await runsOf(first.id);
    const [moved] = await runsOf(second.id);
    expect(old).toMatchObject({ status: 'ended' });
    expect(old!.summary).toBeUndefined();
    expect(moved).toMatchObject({ external: true, toolSessionId: 'MOVE', summary: '두 번째 카드 작업' });
  });

  it('links a session from outside the board without editing sessions.json (agentBoard.linkSession)', async () => {
    const card = await newCard({ implementer: 'claude' });
    const inbox = new RunStore(repo.localDir).inboxDir;
    await fs.mkdir(inbox, { recursive: true });
    const write = (name: string, input: unknown) =>
      fs.writeFile(path.join(inbox, `${name}.json`), JSON.stringify({ tool: 'claude', receivedAt: new Date().toISOString(), input }));
    await write('000000000000001-a', { hook_event_name: 'SessionStart', session_id: 'AGENT', cwd: '/somewhere/else' });
    await service.processInbox();
    expect(service.unlinkedSessions().map((u) => u.sessionId)).toEqual(['AGENT']);

    // 잘못된 인자, 없는 카드, 역할에 지정된 도구와 다른 도구는 연결하지 않는다.
    expect(await service.connectSession(card.id, 'owner', 'claude', 'AGENT')).toBe(false);
    expect(await service.connectSession('TASK-99', 'implementer', 'claude', 'AGENT')).toBe(false);
    expect(await service.connectSession(card.id, 'implementer', 'codex', 'AGENT')).toBe(false);
    expect(await new RunStore(repo.localDir).loadSessions()).toEqual({});

    expect(await service.connectSession(card.id, 'implementer', 'claude', 'AGENT')).toBe(true);
    expect(await new RunStore(repo.localDir).loadSessions()).toEqual({ [card.id]: { implementer: { tool: 'claude', sessionId: 'AGENT' } } });
    expect(service.unlinkedSessions()).toEqual([]);
    expect(board.posted.some((m) => m.type === 'runs' && m.dir === card.id && m.sessions.implementer === 'Claude Code · AGENT')).toBe(true);

    // 연결 후 그 세션의 Hook 이벤트는 카드로 간다.
    await write('000000000000002-b', { hook_event_name: 'Stop', session_id: 'AGENT', last_assistant_message: '연결 확인' });
    await service.processInbox();
    expect((await runsOf(card.id))[0]).toMatchObject({ external: true, toolSessionId: 'AGENT', summary: '연결 확인' });

    // 다른 카드에 같은 세션을 연결할 수 없다 (E-6).
    const other = await newCard({ implementer: 'claude' });
    expect(await service.connectSession(other.id, 'implementer', 'claude', 'AGENT')).toBe(false);
  });
});

describe('opening a session from the card', () => {
  it('opens tool sessions in the tool and board runs in a terminal', async () => {
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    const run = await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'ended' && r.diff !== undefined));
    const worktree = path.resolve(repo.root, run.worktree!);

    // 보드가 실행한 CLI 세션은 worktree 터미널에서 이어 연다.
    stub.commands.add('claude-vscode.primaryEditor.open');
    await service.handle({ type: 'openSession', dir: card.id, tool: 'claude', sessionId: run.toolSessionId! });
    expect(stub.executed).toEqual([]);
    expect(stub.terminals).toEqual([expect.objectContaining({ cwd: worktree, text: [`${FAKE} --resume ${run.toolSessionId}`] })]);

    // 사용자가 도구에서 연 세션은 그 도구의 채팅 화면에서 연다.
    const inbox = new RunStore(repo.localDir).inboxDir;
    await fs.mkdir(inbox, { recursive: true });
    await fs.writeFile(
      path.join(inbox, '000000000000001-x.json'),
      JSON.stringify({ tool: 'claude', receivedAt: new Date().toISOString(), input: { hook_event_name: 'SessionStart', session_id: 'EXT', cwd: worktree } }),
    );
    await service.handle({ type: 'newSession', dir: card.id, role: 'implementer' });
    await service.processInbox();
    await service.handle({ type: 'openSession', dir: card.id, tool: 'claude', sessionId: 'EXT' });
    expect(stub.executed).toEqual([['claude-vscode.primaryEditor.open', 'EXT']]);

    // 도구 화면이 없으면(예: VS Code의 Cursor 세션) 터미널로 연다. CLI도 없으면 알린다.
    await service.handle({ type: 'openSession', dir: card.id, tool: 'cursor', sessionId: 'C1' });
    expect(stub.executed).toHaveLength(1);
    expect(stub.terminals).toHaveLength(1);
    expect(stub.messages.at(-1)?.text).toContain('CLI not found');
  });
});

describe('board settings in runs (TASK-2)', () => {
  it('refuses to run a tool that is turned off (DS-16)', async () => {
    const card = await newCard({ implementer: 'claude' });
    board.enabled = ['codex'];
    await service.startRun(card.id, 'implementer', { resume: false });
    expect(await runsOf(card.id)).toEqual([]);
    expect(stub.messages.some((m) => m.text.includes('turned off'))).toBe(true);
  });

  it('lists sessions linked to a card with their latest status (DS-9)', async () => {
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    const run = await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'ended' && r.diff !== undefined));
    expect(service.cardSessions(card.id)).toEqual([{ tool: 'claude', sessionId: run.toolSessionId, status: 'ended', at: run.lastSeenAt }]);
  });
});

describe('canvas support (TASK-3)', () => {
  it('notifies the implementer session and finds transcripts by session (CA-3, CV-6)', async () => {
    const card = await newCard({ implementer: 'claude' });
    expect(await service.notifyImplementer(card.id, 'broken')).toBe(false);
    await service.startRun(card.id, 'implementer', { resume: false });
    const run = await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'ended' && r.diff !== undefined));
    expect(await service.notifyImplementer(card.id, 'broken canvas')).toBe(true);
    const outbox = JSON.parse(await fs.readFile(path.join(repo.localDir, 'outbox', `claude-${run.toolSessionId}.json`), 'utf8'));
    expect(outbox.messages).toEqual(['broken canvas']);
    expect(service.transcriptForSession(run.toolSessionId!)).toBe(run.transcriptPath);
  });

  it('resumes the implementer session for canvas requests (CA-2)', async () => {
    const card = await newCard({ implementer: 'claude' });
    await service.startRun(card.id, 'implementer', { resume: false });
    const first = await waitFor(async () => (await runsOf(card.id)).find((r) => r.status === 'ended' && r.diff !== undefined));
    await service.startImplementer(card.id, () => 'write the canvas');
    const second = await waitFor(async () => (await runsOf(card.id)).find((r) => r.runId === '2' && r.status === 'ended' && r.diff !== undefined));
    expect(second.toolSessionId).toBe(first.toolSessionId);
    expect(await fs.readFile(path.join(repo.localDir, 'runs', card.id, '2.prompt.md'), 'utf8')).toBe('write the canvas');
  });
});

describe('hook installation', () => {
  it('installs hooks that point to a stable copy of the hook script', async () => {
    const svc = new RunService(board, new RunStore(repo.localDir), path.resolve('dist/hook.js'), () => ({}));
    await svc.init();
    expect(svc.hooksInstalled()).toBe(false);
    stub.answers = [[{ id: 'claude' }, { id: 'cursor' }]];
    await svc.installHooksCommand();
    expect(svc.hooksInstalled()).toBe(true);
    const stable = path.join(repo.localDir, 'hook.js');
    expect(await fs.readFile(stable, 'utf8')).toBe(await fs.readFile(path.resolve('dist/hook.js'), 'utf8'));
    expect(await fs.readFile(path.join(repo.root, '.claude/settings.local.json'), 'utf8')).toContain(stable);
    expect(await fs.readFile(path.join(repo.root, '.cursor/hooks.json'), 'utf8')).toContain('postToolUse');
    expect(await fs.readFile(path.join(repo.root, '.git/info/exclude'), 'utf8')).toMatch(/^\/\.cursor\/hooks\.json$/m);
    svc.dispose();
  });
});

describe('auto card creation and linking (E-9 ~ E-12)', () => {
  let auto: RunService;
  let store: RunStore;
  let seq = 0;

  const hook = async (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    seq += 1;
    await fs.mkdir(store.inboxDir, { recursive: true });
    await fs.writeFile(
      path.join(store.inboxDir, `${String(seq).padStart(15, '0')}-x.json`),
      JSON.stringify({ tool: 'claude', receivedAt: new Date().toISOString(), input, ...extra }),
    );
  };
  const session = (id: string, prompt: string, cwd = repo.root) => [
    { hook_event_name: 'SessionStart', session_id: id, cwd },
    { hook_event_name: 'UserPromptSubmit', session_id: id, cwd, prompt },
  ];
  const outbox = async (id: string) => {
    const text = await fs.readFile(path.join(store.outboxDir, `claude-${id}.json`), 'utf8').catch(() => undefined);
    return text ? (JSON.parse(text) as { messages: string[] }).messages.join('\n') : undefined;
  };
  const classify = (v: unknown) => fs.writeFile(path.join(state, 'classify.json'), JSON.stringify(v));

  beforeEach(async () => {
    store = new RunStore(repo.localDir);
    auto = new RunService(board, store, '', () => ({ claude: FAKE }), { autoCreate: () => true, matcherTool: () => 'claude' });
    await auto.init();
  });
  afterEach(() => auto.dispose());

  it('links the session even before the board sees the new card, without relinking forever', async () => {
    board.staleNewCards = true;
    await classify({ cardId: null, title: '로그 정리', intent: 'x', spec: [], plan: ['a'] });
    for (const input of session('S9', '로그 정리해줘')) await hook(input);
    await auto.processInbox();

    expect((await runsOf('TASK-1'))[0]).toMatchObject({ external: true, toolSessionId: 'S9' });
    const ids = (await store.loadEvents()).map((e) => e.eventId);
    expect(ids.some((id) => id.endsWith(':linked:linked'))).toBe(false);
    expect(ids.length).toBeLessThanOrEqual(4);
  });

  it('creates a Todo card from the first request of an unknown session', async () => {
    await classify({ cardId: null, title: '비밀번호 재설정', intent: '재설정 기능', spec: ['메일 링크'], plan: ['API', '화면'] });
    for (const input of session('S1', '비밀번호 재설정 기능 만들어줘')) await hook(input);
    await auto.processInbox();

    // 만든 카드는 Todo에서 시작하지만, 같은 요청으로 작업이 시작되므로 In Progress로 옮겨진다 (K-4).
    const card = board.getCard('TASK-1')!;
    expect(card).toMatchObject({ title: '비밀번호 재설정', status: 'in_progress', agents: { implementer: { tool: 'claude' } } });
    expect(await repo.readTaskDoc('TASK-1', 'intent')).toContain('> 비밀번호 재설정 기능 만들어줘');
    expect(await repo.readTaskDoc('TASK-1', 'plan')).toContain('- [ ] API\n- [ ] 화면');
    expect(await board.progress('TASK-1')).toEqual({ done: 0, total: 2 });
    // 첫 요청 전에 온 SessionStart도 연결 뒤에 반영된다.
    expect(auto.runStatus('TASK-1')).toEqual({ implementer: 'running' });
    expect((await runsOf('TASK-1'))[0]).toMatchObject({ external: true, toolSessionId: 'S1' });
    expect(await outbox('S1')).toContain('linked to card TASK-1');
    expect(stub.messages.some((m) => m.text.includes('Created card TASK-1'))).toBe(true);

    // 판단 호출은 보드 내부 세션으로 표시된다.
    const calls = await Promise.all(
      (await fs.readdir(state)).filter((f) => f.startsWith('call-')).map(async (f) => JSON.parse(await fs.readFile(path.join(state, f), 'utf8'))),
    );
    expect(calls[0].env.internal).toBe('1');
  });

  it('adds the request to an existing card and notifies the session', async () => {
    const card = await newCard({}, '# Plan\n\n## 체크리스트\n\n- [x] 로그인 화면\n');
    await classify({ cardId: card.id, title: 'x', intent: '소셜 로그인 추가', spec: ['구글 로그인'], plan: ['OAuth 설정'] });
    for (const input of session('S2', '로그인에 구글도 붙여줘')) await hook(input);
    await auto.processInbox();

    expect(board.allCards()).toHaveLength(1);
    expect(await repo.readTaskDoc(card.id, 'plan')).toBe('# Plan\n\n## 체크리스트\n\n- [x] 로그인 화면\n- [ ] OAuth 설정\n');
    expect(await repo.readTaskDoc(card.id, 'spec')).toContain('- 구글 로그인');
    expect(await repo.readTaskDoc(card.id, 'intent')).toContain('소셜 로그인 추가');
    expect((await auto.runs(card.id)).sessions.implementer).toContain('S2');
    expect(await outbox('S2')).toContain('1 checklist item(s) added');
  });

  it('follows an explicit card ID without a classifier, and ignores the board\'s own sessions', async () => {
    const plain = new RunService(board, store, '', () => ({}), { autoCreate: () => true, matcherTool: () => 'none' });
    await plain.init();
    const card = await newCard({});
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'IN', cwd: repo.root, prompt: 'x' }, { internal: true });
    for (const input of session('S3', `${card.id} 이어서 진행`)) await hook(input);
    await plain.processInbox();
    expect(board.allCards()).toHaveLength(1);
    expect((await plain.runs(card.id)).sessions.implementer).toContain('S3');
    expect(await repo.readTaskDoc(card.id, 'intent')).toContain(`> ${card.id} 이어서 진행`);
    plain.dispose();
  });

  it('does not take over a running implementer, but still updates the documents', async () => {
    await fs.writeFile(path.join(state, 'mode'), 'hang');
    const card = await newCard({ implementer: 'claude' });
    await auto.startRun(card.id, 'implementer', { resume: false });
    await waitFor(async () => (await runsOf(card.id)).find((r) => r.lastSeq.stream !== undefined));
    await fs.rm(path.join(state, 'mode'));
    await classify({ cardId: card.id, title: 'x', intent: '추가', spec: [], plan: ['새 항목'] });
    for (const input of session('S4', '이것도 해줘')) await hook(input);
    await auto.processInbox();

    expect(await repo.readTaskDoc(card.id, 'plan')).toContain('- [ ] 새 항목');
    expect((await runsOf(card.id)).length).toBe(1);
    expect(auto.unlinkedSessions().map((u) => u.sessionId)).toContain('S4');
    expect(await outbox('S4')).toContain(card.id);
    await auto.stopAll(board.getCard(card.id)!);
  });

  it('does not auto-link sessions of a tool that is turned off (ST-9)', async () => {
    board.enabled = ['codex'];
    for (const input of session('S6', '새 작업')) await hook(input);
    await auto.processInbox();
    expect(board.allCards()).toHaveLength(0);
    expect(auto.unlinkedSessions().map((u) => u.sessionId)).toEqual(['S6']);
  });

  it('leaves sessions outside the repository unlinked', async () => {
    for (const input of session('S5', '아무거나', '/somewhere/else')) await hook(input);
    await auto.processInbox();
    expect(board.allCards()).toHaveLength(0);
    expect(auto.unlinkedSessions().map((u) => u.sessionId)).toEqual(['S5']);
  });
});
