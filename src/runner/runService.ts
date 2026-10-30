// 실행 관리자: 에이전트 실행·중단·재개, 이벤트 반영, 리뷰 반복 (spec 7~12절).
// 상태 판단은 core/runs·core/status에 맡기고 여기서는 입출력과 순서만 다룬다.

import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ADAPTERS } from '../adapters';
import type { ParsedEvent } from '../adapters/types';
import {
  ACTIVE,
  TERMINAL,
  resolveRun,
  applyEvent,
  latestRunStatus,
  nextLoopStep,
  nextRunId,
  reviewSummaryOf,
  runsOfCard,
  type AgentEvent,
  type EventSource,
  type RunRecord,
  type RunsState,
} from '../core/runs';
import { cardActivity, type CardActivity } from '../core/activity';
import { runText } from '../core/report';
import { applyRunStatusChange, autoMoveTarget, canAutoDone, type ReviewSummary } from '../core/status';
import { ROLES, TOOL_IDS, type BoardSettings, type Card, type Progress, type Role, type SharedDoc, type TaskDoc, type ToolId } from '../core/types';
import type { Locale, MessageKey } from '../shared/i18n';
import type { BoardState, CardSession, RunView, ToExtension, ToolInfo, ToWebview } from '../shared/protocol';
import { pathExists, readTextIfExists, toJson, writeFileAtomic } from '../storage/fsutil';
import { addToExclude, changesSince, codeRef, createWorktree, defaultWorkspace, headCommit, isTracked, mergeBase } from './git';
import { HOOK_FILES, hookCommand, installHooks } from './hookInstall';
import { isLinkedEvent, LINKED_SUFFIX } from './runStore';
import { openInToolUi, resumeInTerminal } from './openSession';
import { isProcessAlive, spawnAgent, type AgentProcess } from './process';
import {
  addToExistingDocs,
  classifierPrompt,
  explicitMatch,
  fallbackDecision,
  fillNewCardDocs,
  parseClassifierOutput,
  sessionNotice,
  type CardSummary,
  type MatchDecision,
} from './cardMatcher';
import { runClassifier } from './classifier';
import { fixPrompt, implementerPrompt, parseReport, parseReview, reviewerPrompt, type PromptDocs } from './prompt';
import type { RunsBridge } from '../extension/runsBridge';
import type { RunStore, SessionBindings, UnlinkedSession } from './runStore';
import { envWithBinary, findBinary, findExecutable, readVersion } from './tools';

/** RunService가 보드에 접근하는 경계 (BoardController가 구현). */
export interface BoardAccess {
  readonly root: string;
  readonly locale: Locale;
  t(key: MessageKey, params?: Record<string, string | number>): string;
  getCard(id: string): Card | undefined;
  allCards(): Card[];
  saveCard(card: Card): Promise<void>;
  progress(id: string): Promise<Progress>;
  settings(): BoardSettings;
  /** 이 보드에서 연결할 수 있는 도구 (TASK-2 ST-4) */
  enabledTools(): ToolId[];
  sharedDocs(): SharedDoc[];
  taskDocPath(id: string, doc: TaskDoc): string;
  /** 사용자 이동과 같은 규칙으로 카드를 옮긴다. */
  moveByUser(id: string, to: Card['status']): Promise<void>;
  /** Todo 끝에 카드를 만든다. */
  createCard(title: string): Promise<Card | undefined>;
  refresh(): void;
  post(msg: ToWebview): void;
}

/** 카드 판단에 쓸 CLI. auto는 설치된 Claude Code → Codex → Cursor 순 */
export type MatcherTool = 'auto' | ToolId | 'none';

export interface RunServiceOptions {
  /** 카드에 연결되지 않은 세션의 첫 요청으로 카드를 만들거나 연결한다 (E-9) */
  autoCreate: () => boolean;
  matcherTool: () => MatcherTool;
  /** canvas 작성 안내서 경로 (TASK-3 CA-4) */
  canvasGuide?: string;
}

const DEFAULT_OPTIONS: RunServiceOptions = { autoCreate: () => false, matcherTool: () => 'auto' };
/** 판단을 기다리는 동안 모아 두는 세션당 이벤트 수 */
const PENDING_LIMIT = 50;

const LIVENESS_POLL_MS = 5000;
/** 보드를 자주 다시 읽어도 worktree git 명령은 이 간격 이상으로만 실행한다. */
const CODE_REF_INTERVAL_MS = 3000;

export class RunService implements RunsBridge, vscode.Disposable {
  private state: RunsState = { runs: [], seenEventIds: [] };
  private sessions: SessionBindings = {};
  private seen: Record<string, string> = {};
  private unlinked: UnlinkedSession[] = [];
  private toolInfo: ToolInfo[] = [];
  private binaries: Partial<Record<ToolId, string>> = {};
  private readonly procs = new Map<string, AgentProcess>();
  private readonly codeRefs = new Map<string, string | undefined>();
  private readonly timers: NodeJS.Timeout[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private hookTools: ToolId[] = [];
  private codeRefsAt = 0;
  private ready?: Promise<void>;
  private inboxRun?: Promise<void>;
  /** 프로세스를 띄우는 중인 카드·역할. 연속 클릭으로 두 번 실행되지 않게 한다. */
  private readonly starting = new Set<string>();
  private runnerCounter = 0;
  /** 카드를 판단하는 중이거나 첫 요청을 기다리는 세션의 이벤트 (E-9) */
  private readonly pending = new Map<string, AgentEvent[]>();
  private readonly linking = new Set<string>();

  constructor(
    private readonly board: BoardAccess,
    private readonly store: RunStore,
    private readonly hookScript: string,
    private readonly toolPaths: () => Partial<Record<ToolId, string>>,
    private readonly options: RunServiceOptions = DEFAULT_OPTIONS,
  ) {}

  dispose(): void {
    this.timers.forEach(clearInterval);
  }

  private report(err: unknown): void {
    void vscode.window.showErrorMessage(`Agent Board: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** 변경을 한 번에 하나씩 처리한다. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** 기록을 읽기 전에 이벤트를 반영하면 빈 상태로 runs.json을 덮어쓰므로, 다른 작업은 init이 끝난 뒤에 한다. */
  init(): Promise<void> {
    this.ready ??= this.load();
    return this.ready;
  }

  private async load(): Promise<void> {
    this.state = await this.store.loadRuns();
    this.sessions = await this.store.loadSessions().catch(() => ({}));
    this.unlinked = await this.store.loadUnlinked().catch(() => []);
    this.seen = await this.store.loadSeen().catch(() => ({}));
    this.hookTools = await this.loadHookTools();
    await this.refreshHookScript();
    await this.detectTools();
    await this.recover();
    await this.processInbox();
  }

  // ---- RunsBridge ----

  runStatus(cardId: string) {
    return latestRunStatus(this.state, cardId);
  }

  reviewSummary(cardId: string): ReviewSummary {
    return reviewSummaryOf(this.state, cardId, this.codeRefs.get(cardId));
  }

  /** 삭제·Suspended 이동 시 중단해야 하는 회차가 있는지. 프로세스 없는 외부 세션은 제외한다. */
  hasActiveRun(cardId: string): boolean {
    return ROLES.some((role) => {
      if (this.starting.has(this.key(cardId, role))) return true;
      const run = this.latestRun(cardId, role);
      if (!run || run.external) return false;
      if (run.status === 'running' || run.status === 'stopping' || run.status === 'waiting') return true;
      return run.status === 'input_required' && this.procs.has(this.key(cardId, run.runId));
    });
  }

  async stopAll(card: Card): Promise<void> {
    await Promise.all(ROLES.map((role) => this.stopRun(card.id, role)));
  }

  tools(): ToolInfo[] {
    return this.toolInfo;
  }

  unlinkedSessions(): BoardState['unlinkedSessions'] {
    return this.unlinked;
  }

  async runs(cardId: string): Promise<{ runs: RunView[]; sessions: Partial<Record<Role, string>> }> {
    const card = this.board.getCard(cardId);
    const current = card ? await this.hashInputs(card) : {};
    const progress = await this.board.progress(cardId);
    const runs = runsOfCard(this.state, cardId).map(
      (r): RunView => ({
        runId: r.runId,
        role: r.role,
        tool: r.tool,
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        ...runText(r, r.role === 'implementer' ? parseReport(r.summary) : undefined, progress),
        changes: r.changes,
        diff: r.diff,
        reviewedRef: r.reviewedRef,
        transcriptPath: r.transcriptPath,
        statusDetail: r.statusDetail,
        inputChanged: Object.entries(r.inputVersions).some(([k, v]) => current[k] !== undefined && current[k] !== v),
      }),
    );
    const sessions: Partial<Record<Role, string>> = {};
    for (const role of ROLES) {
      const b = this.sessions[cardId]?.[role];
      if (b) sessions[role] = `${this.board.t(`tool.${b.tool}`)} · ${b.sessionId}`;
    }
    return { runs, sessions };
  }

  async handle(msg: ToExtension): Promise<boolean> {
    if (!this.ready) return false;
    await this.ready;
    switch (msg.type) {
      case 'markSeen':
        await this.markSeen(msg.dir);
        return true;
      case 'loadRuns':
        await this.postRuns(msg.dir);
        return true;
      case 'startRun':
        await this.startRun(msg.dir, msg.role, { resume: msg.resume });
        return true;
      case 'stopRun':
        await this.stopRun(msg.dir, msg.role);
        return true;
      case 'resolveRun':
        await this.serial(() =>
          this.updateRun(msg.dir, msg.runId, { status: msg.status, endedAt: new Date().toISOString(), process: undefined }),
        );
        this.board.refresh();
        return true;
      case 'openTranscript': {
        const run = this.findRun(msg.dir, msg.runId);
        if (run?.transcriptPath) await vscode.window.showTextDocument(vscode.Uri.file(run.transcriptPath), { preview: true });
        return true;
      }
      case 'pickSession':
        await this.pickSession(msg.dir, msg.role);
        return true;
      case 'newSession':
        await this.unbind(msg.dir, msg.role);
        return true;
      case 'linkSession':
        await this.linkSession(msg.tool, msg.sessionId);
        return true;
      case 'openSession':
        await this.openSession(msg.dir, msg.tool, msg.sessionId);
        return true;
      case 'requestReview':
        await this.requestReview(msg.dir);
        return true;
      case 'installHooks':
        await this.installHooksCommand();
        this.board.refresh();
        return true;
      case 'detectTools':
        await this.detectTools();
        this.board.refresh();
        return true;
      case 'createWorktree': {
        const card = this.board.getCard(msg.dir);
        if (card) await this.ensureWorktree(card);
        this.board.refresh();
        return true;
      }
      default:
        return false;
    }
  }

  private async postRuns(cardId: string): Promise<void> {
    this.board.post({ type: 'runs', dir: cardId, ...(await this.runs(cardId)) });
  }

  // ---- 도구 ----

  async detectTools(): Promise<void> {
    const overrides = this.toolPaths();
    this.toolInfo = await Promise.all(
      TOOL_IDS.map(async (id): Promise<ToolInfo> => {
        const adapter = ADAPTERS[id];
        const bin = await findBinary(adapter, overrides[id]);
        const version = bin ? await readVersion(bin) : undefined;
        if (bin) this.binaries[id] = bin;
        else delete this.binaries[id];
        return { id, installed: !!bin && !!version, version, capabilities: { ...adapter.capabilities } };
      }),
    );
  }

  // ---- 작업 공간 ----

  worktreeAbs(card: Card): string | undefined {
    return card.workspace?.worktree ? path.resolve(this.board.root, card.workspace.worktree) : undefined;
  }

  /** W-1, W-2: 카드의 worktree가 없으면 만든다. */
  async ensureWorktree(card: Card): Promise<string> {
    const existing = this.worktreeAbs(card);
    if (existing && (await pathExists(existing))) return existing;
    const ws = card.workspace?.worktree && card.workspace.branch ? { branch: card.workspace.branch, worktree: card.workspace.worktree } : defaultWorkspace(this.board.root, card.id);
    const target = path.resolve(this.board.root, ws.worktree);
    const owner = this.board.allCards().find((c) => c.id !== card.id && this.worktreeAbs(c) === target);
    if (owner) throw new Error(`worktree ${ws.worktree} is used by ${owner.id}`);
    await createWorktree(this.board.root, ws.worktree, ws.branch);
    const fresh = this.board.getCard(card.id) ?? card;
    await this.board.saveCard({ ...fresh, workspace: ws, updatedAt: new Date().toISOString() });
    await this.installHooksInto(target, this.hookTools);
    return target;
  }

  // ---- 실행 ----

  private key(cardId: string, runId: string): string {
    return `${cardId}#${runId}`;
  }

  private findRun(cardId: string, runId: string): RunRecord | undefined {
    return this.state.runs.find((r) => r.cardId === cardId && r.runId === runId);
  }

  private latestRun(cardId: string, role: Role): RunRecord | undefined {
    return runsOfCard(this.state, cardId)
      .filter((r) => r.role === role)
      .at(-1);
  }

  private docPaths(card: Card): PromptDocs {
    const shared = this.board
      .sharedDocs()
      .filter((d) => card.relatedDocs.includes(d.id))
      .map((d) => ({ name: d.name, path: path.join(this.board.root, d.path) }));
    return {
      intent: this.board.taskDocPath(card.id, 'intent'),
      spec: this.board.taskDocPath(card.id, 'spec'),
      plan: this.board.taskDocPath(card.id, 'plan'),
      shared,
    };
  }

  /** M-4: 작업 문서와 관련 공용 문서의 콘텐츠 해시. 키는 레포 기준 상대 경로. */
  private async hashInputs(card: Card): Promise<Record<string, string>> {
    const docs = this.docPaths(card);
    const files = [docs.intent, docs.spec, docs.plan, ...docs.shared.map((d) => d.path)];
    const out: Record<string, string> = {};
    for (const file of files) {
      const content = await readTextIfExists(file);
      out[path.relative(this.board.root, file).split(path.sep).join('/')] =
        content === undefined ? 'missing' : createHash('sha256').update(content).digest('hex').slice(0, 16);
    }
    return out;
  }

  async startRun(
    cardId: string,
    role: Role,
    opts: { resume: boolean; prompt?: (card: Card, docs: PromptDocs) => string; loopIteration?: number },
  ): Promise<void> {
    const card = this.board.getCard(cardId);
    if (!card) return;
    const agent = card.agents[role];
    if (!agent) {
      void vscode.window.showWarningMessage(this.board.t('msg.assignAgentFirst'));
      return;
    }
    if (!this.board.enabledTools().includes(agent.tool)) {
      void vscode.window.showWarningMessage(this.board.t('msg.toolDisabled', { tool: this.board.t(`tool.${agent.tool}`) }));
      return;
    }
    const bin = this.binaries[agent.tool];
    if (!bin) {
      void vscode.window.showErrorMessage(this.board.t('runs.notInstalled', { tool: this.board.t(`tool.${agent.tool}`) }));
      return;
    }
    const latest = this.latestRun(cardId, role);
    if (latest && !latest.external && (latest.status === 'running' || latest.status === 'stopping' || latest.status === 'waiting')) return;
    const startKey = this.key(cardId, role);
    if (this.starting.has(startKey)) return;
    this.starting.add(startKey);
    try {
      await this.launch(card, role, agent, opts);
    } finally {
      this.starting.delete(startKey);
    }
  }

  private async launch(
    card: Card,
    role: Role,
    agent: NonNullable<Card['agents'][Role]>,
    opts: { resume: boolean; prompt?: (card: Card, docs: PromptDocs) => string; loopIteration?: number },
  ): Promise<void> {
    const cardId = card.id;
    const adapter = ADAPTERS[agent.tool];
    const bin = this.binaries[agent.tool]!;

    // W-3: 읽기 전용을 지원하지 않는 도구로 리뷰하면 먼저 확인한다.
    if (role === 'reviewer' && !adapter.capabilities.readOnly) {
      const ok = this.board.t('msg.continue');
      const choice = await vscode.window.showWarningMessage(
        this.board.t('msg.readOnlyWarning', { tool: this.board.t(`tool.${agent.tool}`) }),
        { modal: true },
        ok,
      );
      if (choice !== ok) return;
    }

    const binding = this.sessions[cardId]?.[role];
    if (opts.resume && (!binding || binding.tool !== agent.tool)) {
      opts = { ...opts, resume: false };
    }

    const cwd = await this.ensureWorktree(card);
    const fresh = this.board.getCard(cardId) ?? card;
    const docs = this.docPaths(fresh);
    const now = new Date().toISOString();

    let baseCommit: string | undefined;
    let reviewedRef: string | undefined;
    let prompt: string;
    if (role === 'reviewer') {
      const rootHead = await headCommit(this.board.root);
      baseCommit = rootHead ? await mergeBase(cwd, rootHead) : undefined;
      reviewedRef = await codeRef(cwd);
      prompt = reviewerPrompt(fresh, docs, baseCommit);
    } else {
      baseCommit = this.latestRun(cardId, 'implementer')?.baseCommit ?? (await headCommit(cwd));
      prompt = opts.prompt ? opts.prompt(fresh, docs) : implementerPrompt(fresh, docs, fresh.workspace?.branch);
    }

    const launch = adapter.buildLaunch({
      prompt,
      cwd,
      readOnly: role === 'reviewer',
      resumeSessionId: opts.resume ? binding!.sessionId : undefined,
      newSessionId: opts.resume ? undefined : randomUUID(),
      addDirs: [path.dirname(docs.plan)],
      options: agent.options,
    });

    const runId = await this.serial(async () => {
      const id = nextRunId(this.state, cardId);
      const record: RunRecord = {
        runId: id,
        cardId,
        role,
        tool: agent.tool,
        toolSessionId: opts.resume ? binding!.sessionId : launch.presetSessionId,
        status: 'waiting',
        startedAt: now,
        branch: fresh.workspace?.branch,
        worktree: fresh.workspace?.worktree,
        baseCommit,
        reviewedRef,
        inputVersions: await this.hashInputs(fresh),
        transcriptPath: path.join(this.store.runDir(cardId), `${id}.jsonl`),
        lastSeenAt: now,
        lastSeq: {},
        statusVersionAtStart: fresh.statusVersion,
        loopIteration: opts.loopIteration,
      };
      this.state = { ...this.state, runs: [...this.state.runs, record] };
      await this.store.saveRuns(this.state);
      return id;
    });
    await writeFileAtomic(path.join(this.store.runDir(cardId), `${runId}.prompt.md`), prompt);
    if (!opts.resume && launch.presetSessionId) await this.bind(cardId, role, agent.tool, launch.presetSessionId, true);

    let proc: AgentProcess;
    try {
      proc = await spawnAgent({
        command: bin,
        args: launch.args,
        cwd,
        env: envWithBinary(bin, { AGENT_BOARD_RUN_ID: runId, AGENT_BOARD_CARD_ID: cardId }),
        logFile: path.join(this.store.runDir(cardId), `${runId}.jsonl`),
        onLine: (line, seq) => void this.onStreamLine(cardId, runId, agent.tool, line, seq).catch((err) => this.report(err)),
      });
    } catch (err) {
      await this.dispatch(this.runnerEvent(cardId, runId, agent.tool, 'run.failed', { error: (err as Error).message }));
      return;
    }
    this.procs.set(this.key(cardId, runId), proc);
    await this.serial(() => this.updateRun(cardId, runId, { process: { pid: proc.pid, startedAt: proc.startedAt } }));
    await this.dispatch(this.runnerEvent(cardId, runId, agent.tool, 'run.started'));
    void proc.exited.then((res) => this.onExit(cardId, runId, agent.tool, res)).catch((err) => this.report(err));
  }

  /**
   * 실행 관리자가 만드는 이벤트. 순번은 시각 기반으로 계속 커지므로, 중단 시간 초과 뒤에 온 실제 종료도 반영된다.
   */
  private runnerEvent(cardId: string, runId: string, tool: ToolId, type: AgentEvent['type'], payload?: AgentEvent['payload']): AgentEvent {
    const seq = type === 'run.started' ? 0 : Date.now() * 100 + (this.runnerCounter++ % 100);
    return {
      eventId: `${cardId}:${runId}:runner:${seq}:${type}`,
      type,
      tool,
      cardId,
      runId,
      source: 'runner',
      seq,
      occurredAt: new Date().toISOString(),
      payload,
    };
  }

  private async onStreamLine(cardId: string, runId: string, tool: ToolId, line: string, seq: number): Promise<void> {
    const parsed = ADAPTERS[tool].parseStreamLine(line);
    for (const [i, p] of parsed.entries()) {
      await this.dispatch(this.toEvent(p, { cardId, runId, tool, source: 'stream', seq: seq * 10 + i, id: `${cardId}:${runId}:stream:${seq}:${i}` }));
    }
  }

  private toEvent(
    p: ParsedEvent,
    ctx: { cardId?: string; runId?: string; tool: ToolId; source: EventSource; seq: number; id: string; at?: string },
  ): AgentEvent {
    return {
      eventId: ctx.id,
      type: p.type,
      tool: ctx.tool,
      toolSessionId: p.sessionId,
      cardId: ctx.cardId,
      runId: ctx.runId,
      source: ctx.source,
      seq: ctx.seq,
      occurredAt: ctx.at ?? new Date().toISOString(),
      payload: p.payload,
    };
  }

  private async onExit(
    cardId: string,
    runId: string,
    tool: ToolId,
    res: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string },
  ): Promise<void> {
    this.procs.delete(this.key(cardId, runId));
    const run = this.findRun(cardId, runId);
    if (!run) return;
    // 기록 갱신이 실패해도 종료 이벤트는 반드시 보낸다.
    await this.serial(() => this.updateRun(cardId, runId, { process: undefined })).catch((err) => this.report(err));
    if (run.stopRequestedAt) {
      await this.dispatch(this.runnerEvent(cardId, runId, tool, 'run.stopped'));
    } else if (res.code === 0) {
      // headless 실행이 권한 요청으로 끝났으면 "사용자 입력 필요"를 유지한다.
      if (run.status !== 'input_required') await this.dispatch(this.runnerEvent(cardId, runId, tool, 'run.ended'));
      else await this.afterRun(cardId, runId);
    } else {
      const error = res.stderrTail.split('\n').slice(-5).join('\n') || `exit ${res.code ?? res.signal}`;
      await this.dispatch(this.runnerEvent(cardId, runId, tool, 'run.failed', { error }));
    }
  }

  /** R-2: 중단 요청 후 시간 안에 끝나지 않으면 "상태 확인 필요". */
  async stopRun(cardId: string, role: Role): Promise<void> {
    const run = this.latestRun(cardId, role);
    if (!run || !ACTIVE.has(run.status)) return;
    const proc = this.procs.get(this.key(cardId, run.runId));
    const now = new Date().toISOString();
    if (!proc) {
      // 프로세스 없이 입력을 기다리던 headless 회차는 바로 중단됨으로 둔다.
      if (!run.external) await this.serial(() => this.updateRun(cardId, run.runId, { status: 'stopped', endedAt: now }));
      this.board.refresh();
      return;
    }
    await this.serial(() => this.updateRun(cardId, run.runId, { status: 'stopping', stopRequestedAt: now }));
    this.board.refresh();
    const result = await proc.stop(this.board.settings().stopTimeoutSec * 1000);
    if (result === 'timeout') {
      await this.dispatch(this.runnerEvent(cardId, run.runId, run.tool, 'process.lost', { reason: 'stop timeout' }));
    }
  }

  /** A-2: 리뷰 요청. 카드를 Review로 옮기고 리뷰어를 실행한다. */
  private async requestReview(cardId: string): Promise<void> {
    const card = this.board.getCard(cardId);
    if (!card) return;
    if (card.status !== 'review') await this.board.moveByUser(cardId, 'review');
    await this.startRun(cardId, 'reviewer', { resume: false });
  }

  // ---- 이벤트 반영 ----

  async dispatch(incoming: AgentEvent): Promise<void> {
    const event = await this.followRebind(incoming);
    const { effects, changed } = await this.serial(async () => {
      await this.store.appendEvent(event);
      const result = applyEvent(this.state, event);
      this.state = result.state;
      await this.store.saveRuns(this.state);
      // E-5: 새로 알게 된 세션을 역할에 연결한다.
      const changed = result.changed;
      if (changed?.toolSessionId && this.latestRun(changed.cardId, changed.role) === changed && !changed.external) {
        const current = this.sessions[changed.cardId]?.[changed.role];
        if (current?.sessionId !== changed.toolSessionId) {
          await this.bindUnlocked(changed.cardId, changed.role, changed.tool, changed.toolSessionId, true);
        }
      }
      return result;
    });
    if (changed?.role === 'implementer' && !TERMINAL.has(changed.status)) {
      // 보드 밖에서 연 세션은 회차가 길어서, 새 요청마다 K-3 기준 시점을 다시 잡는다.
      if (event.type === 'turn.started' && changed.external) await this.rebaseStatusVersion(changed.cardId, changed.runId);
      // 보드가 띄운 회차는 프롬프트와 함께 시작하고, 보드 밖 세션은 첫 요청부터 작업으로 본다.
      if (event.type === 'turn.started' || (event.type === 'run.started' && !changed.external)) {
        await this.autoMove(changed.cardId, changed.runId, 'start');
      }
      if (event.type === 'response.completed' && event.payload?.idle) await this.autoMove(changed.cardId, changed.runId, 'turnEnd');
    }
    for (const effect of effects) {
      if (effect.kind === 'runFinished') await this.afterRun(effect.cardId, effect.runId);
      // 연결해서 다시 보낸 이벤트는 다시 연결하지 않는다.
      else if (effect.kind === 'unmatched' && !isLinkedEvent(effect.event)) await this.handleUnmatched(effect.event);
    }
    this.board.refresh();
  }

  /**
   * 세션을 다른 카드로 옮겼으면(세션 선택) 그 뒤 이벤트는 옮긴 카드의 새 회차로 보내고, 이전 카드의 회차는 끝낸다.
   * 회차는 세션 ID로 찾으므로, 옮긴 카드에 회차가 없으면 이벤트가 계속 이전 카드에 쌓인다.
   */
  private async followRebind(event: AgentEvent): Promise<AgentEvent> {
    if (event.runId || !event.toolSessionId) return event;
    const run = resolveRun(this.state, event);
    const bound = this.findBoundCard(event.tool, event.toolSessionId);
    if (!run || !bound || (run.cardId === bound.cardId && run.role === bound.role)) return event;
    await this.attachExternal(bound.cardId, bound.role, event.tool, event.toolSessionId, event.occurredAt);
    if (!TERMINAL.has(run.status)) {
      await this.serial(() => this.updateRun(run.cardId, run.runId, { status: 'ended', endedAt: event.occurredAt, statusDetail: this.board.t('msg.sessionMoved', { id: bound.cardId }) }));
    }
    const target = this.latestRun(bound.cardId, bound.role);
    return target ? { ...event, cardId: bound.cardId, runId: target.runId } : event;
  }

  private async rebaseStatusVersion(cardId: string, runId: string): Promise<void> {
    const card = this.board.getCard(cardId);
    if (card) await this.serial(() => this.updateRun(cardId, runId, { statusVersionAtStart: card.statusVersion }));
  }

  /** K-4: 구현자 실행에 따라 카드를 옮긴다. 회차 중에 사용자가 옮긴 카드는 건드리지 않는다 (K-3). */
  private async autoMove(cardId: string, runId: string, trigger: 'start' | 'turnEnd'): Promise<void> {
    const run = this.findRun(cardId, runId);
    const card = this.board.getCard(cardId);
    if (!run || !card) return;
    const to = autoMoveTarget(card.status, trigger, trigger === 'turnEnd' ? await this.board.progress(cardId) : { done: 0, total: 0 });
    const next = to && applyRunStatusChange(card, run.statusVersionAtStart, to, new Date().toISOString());
    if (!next) return;
    await this.board.saveCard(next);
    // 자동 이동은 사용자 이동이 아니므로 같은 회차의 다음 자동 이동(Review, Done)을 막지 않는다.
    await this.serial(() => this.updateRun(cardId, runId, { statusVersionAtStart: next.statusVersion }));
  }

  private async updateRun(cardId: string, runId: string, patch: Partial<RunRecord>): Promise<void> {
    this.state = {
      ...this.state,
      runs: this.state.runs.map((r) => (r.cardId === cardId && r.runId === runId ? { ...r, ...patch } : r)),
    };
    await this.store.saveRuns(this.state);
  }

  /** 회차 종료 후: 변경 사항 수집, 리뷰 결과 해석, 자동 완료와 자동 수정·재리뷰. */
  private async afterRun(cardId: string, runId: string): Promise<void> {
    const run = this.findRun(cardId, runId);
    const card = this.board.getCard(cardId);
    if (!run || !card) return;
    const cwd = this.worktreeAbs(card);
    const patch: Partial<RunRecord> = {};
    if (cwd && (await pathExists(cwd))) {
      if (run.role === 'implementer') {
        const changes = await changesSince(cwd, run.baseCommit).catch(() => undefined);
        if (changes) {
          patch.changes = changes.files;
          patch.diff = changes.diff;
        }
        patch.headCommit = await headCommit(cwd);
      }
      this.codeRefs.set(cardId, await codeRef(cwd).catch(() => undefined));
    }
    if (run.role === 'reviewer') patch.review = parseReview(run.summary);
    await this.serial(() => this.updateRun(cardId, runId, patch));

    const finished = this.findRun(cardId, runId)!;
    if (finished.role === 'implementer' && finished.status === 'ended') await this.autoMove(cardId, runId, 'turnEnd');
    if (finished.role === 'reviewer' && finished.review?.verdict === 'pass') {
      // K-2: 리뷰 통과 + 체크리스트 완료 + 재리뷰 불필요 → Done (K-3 보호).
      if (canAutoDone(await this.board.progress(cardId), this.reviewSummary(cardId))) {
        // 변경 수집 중에 사용자가 카드를 옮겼을 수 있으므로 최신 카드로 판단한다 (K-3).
        const latest = this.board.getCard(cardId) ?? card;
        const next = applyRunStatusChange(latest, finished.statusVersionAtStart, 'done', new Date().toISOString());
        if (next) await this.board.saveCard(next);
      }
    }

    if (!card.autoReview) return;
    const decision = nextLoopStep(this.state, finished, this.board.settings().maxReviewIterations);
    if (decision.kind === 'fix') {
      const findings = decision.findings;
      await this.startRun(cardId, 'implementer', {
        resume: !!this.sessions[cardId]?.implementer && ADAPTERS[card.agents.implementer?.tool ?? 'claude'].capabilities.resume,
        prompt: (c, docs) => fixPrompt(c, docs, findings),
        loopIteration: decision.iteration,
      });
    } else if (decision.kind === 'review') {
      await this.startRun(cardId, 'reviewer', { resume: false, loopIteration: decision.iteration });
    } else if (decision.kind === 'limit' || decision.kind === 'conflict') {
      const detail =
        decision.kind === 'limit' ? this.board.t('msg.iterationLimit', { max: decision.max }) : this.board.t('msg.sameFindings');
      await this.serial(() => this.updateRun(cardId, runId, { status: 'input_required', statusDetail: detail }));
      void vscode.window.showWarningMessage(`${cardId}: ${detail}`);
    }
  }

  /** 리뷰가 있는 카드의 현재 코드 버전을 다시 계산한다 (A-5). */
  async refreshCodeRefs(): Promise<void> {
    for (const card of this.board.allCards()) {
      if (!runsOfCard(this.state, card.id).some((r) => r.review)) continue;
      const cwd = this.worktreeAbs(card);
      this.codeRefs.set(card.id, cwd && (await pathExists(cwd)) ? await codeRef(cwd).catch(() => undefined) : undefined);
    }
  }

  // ---- 복구 (V-1, V-2) ----

  private async recover(): Promise<void> {
    for (const run of this.state.runs) {
      if (!ACTIVE.has(run.status) && run.status !== 'waiting') continue;
      if (run.external) continue;
      if (!run.process) {
        if (run.status === 'waiting' || run.status === 'running' || run.status === 'stopping') {
          await this.dispatch(this.runnerEvent(run.cardId, run.runId, run.tool, 'process.lost', { reason: 'process not started' }));
        }
        continue;
      }
      if (await isProcessAlive(run.process.pid, run.process.startedAt)) {
        this.watchOrphan(run);
      } else {
        await this.dispatch(this.runnerEvent(run.cardId, run.runId, run.tool, 'process.lost', { reason: 'process not found' }));
      }
    }
  }

  /** 출력을 잃은 채 살아 있는 프로세스는 끝날 때까지 지켜본다. */
  private watchOrphan(run: RunRecord): void {
    const timer = setInterval(() => {
      void (async () => {
        const current = this.findRun(run.cardId, run.runId);
        if (!current?.process || !ACTIVE.has(current.status)) {
          clearInterval(timer);
          return;
        }
        if (!(await isProcessAlive(current.process.pid, current.process.startedAt))) {
          clearInterval(timer);
          await this.dispatch(this.runnerEvent(run.cardId, run.runId, run.tool, 'process.lost', { reason: 'process ended without end event' }));
        }
      })().catch((err) => this.report(err));
    }, LIVENESS_POLL_MS);
    this.timers.push(timer);
  }

  // ---- 세션 (E-5 ~ E-8) ----

  private async bind(cardId: string, role: Role, tool: ToolId, sessionId: string, quiet = false): Promise<boolean> {
    return this.serial(() => this.bindUnlocked(cardId, role, tool, sessionId, quiet));
  }

  private async bindUnlocked(cardId: string, role: Role, tool: ToolId, sessionId: string, quiet: boolean): Promise<boolean> {
    for (const [otherCard, roles] of Object.entries(this.sessions)) {
      for (const [otherRole, b] of Object.entries(roles)) {
        if (b && b.tool === tool && b.sessionId === sessionId && (otherCard !== cardId || otherRole !== role)) {
          if (!quiet) {
            void vscode.window.showWarningMessage(
              this.board.t('msg.sessionInUse', { id: otherCard, role: this.board.t(`role.${otherRole as Role}`) }),
            );
          }
          return false;
        }
      }
    }
    this.sessions = { ...this.sessions, [cardId]: { ...this.sessions[cardId], [role]: { tool, sessionId } } };
    await this.store.saveSessions(this.sessions);
    return true;
  }

  private async unbind(cardId: string, role: Role): Promise<void> {
    await this.serial(async () => {
      const roles = { ...this.sessions[cardId] };
      delete roles[role];
      this.sessions = { ...this.sessions, [cardId]: roles };
      await this.store.saveSessions(this.sessions);
    });
    await this.postRuns(cardId);
  }

  private async pickSession(cardId: string, role: Role): Promise<void> {
    const card = this.board.getCard(cardId);
    const tool = card?.agents[role]?.tool;
    if (!card || !tool) {
      void vscode.window.showWarningMessage(this.board.t('msg.assignAgentFirst'));
      return;
    }
    const cwd = this.worktreeAbs(card) ?? this.board.root;
    const sessions = await ADAPTERS[tool].listSessions(cwd);
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(this.board.t('msg.noSessions', { tool: this.board.t(`tool.${tool}`) }));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.id, description: new Date(s.updatedAt).toLocaleString(), detail: s.title })),
      { placeHolder: this.board.t('runs.pickSession') },
    );
    if (pick && (await this.bind(cardId, role, tool, pick.label))) await this.postRuns(cardId);
  }

  /** E-8: 카드를 알 수 없는 세션의 이벤트. worktree 경로로 카드를 찾고, 못 찾으면 연결 대기 목록에 둔다. */
  private async handleUnmatched(event: AgentEvent): Promise<void> {
    if (!event.toolSessionId) return;
    let target = this.findBoundCard(event.tool, event.toolSessionId) ?? this.findPastRunCard(event.tool, event.toolSessionId);
    const worktreeCard = this.cardOfWorktree(event.payload?.cwd);
    if (!target && worktreeCard) {
      // 같은 도구가 지정됐고 아직 세션이 없는 역할에만 붙인다. 실행 중인 에이전트의 세션을 빼앗지 않는다.
      const role = ROLES.find((r) => worktreeCard.agents[r]?.tool === event.tool && !this.sessions[worktreeCard.id]?.[r]);
      if (role) target = { cardId: worktreeCard.id, role };
    }
    if (target) {
      await this.attachExternal(target.cardId, target.role, event.tool, event.toolSessionId, event.occurredAt);
      await this.dispatchLinked(event, target.cardId, this.latestRun(target.cardId, target.role)?.runId);
      return;
    }
    // ST-9: 꺼진 도구의 세션은 자동으로 연결하지 않는다.
    if (this.options.autoCreate() && this.inRepo(event.payload?.cwd) && this.board.enabledTools().includes(event.tool)) {
      await this.autoLink(event, worktreeCard?.id);
      return;
    }
    await this.addUnlinked(event);
  }

  /**
   * 카드를 찾은 세션의 이벤트를 그 회차로 다시 보낸다. 회차가 없으면 보내지 않는다.
   * 회차 없이 보내면 다시 "알 수 없는 세션"이 되어 연결을 끝없이 반복한다.
   */
  private async dispatchLinked(event: AgentEvent, cardId: string, runId: string | undefined): Promise<void> {
    if (!runId || isLinkedEvent(event)) return;
    await this.dispatch({ ...event, eventId: `${event.eventId}${LINKED_SUFFIX}`, cardId, runId });
  }

  private async addUnlinked(event: AgentEvent): Promise<void> {
    if (!event.toolSessionId || this.unlinked.some((u) => u.tool === event.tool && u.sessionId === event.toolSessionId)) return;
    this.unlinked = [...this.unlinked, { tool: event.tool, sessionId: event.toolSessionId, cwd: event.payload?.cwd ?? '' }];
    await this.store.saveUnlinked(this.unlinked);
  }

  private cardOfWorktree(cwd: string | undefined): Card | undefined {
    if (!cwd) return undefined;
    const abs = path.resolve(cwd);
    return this.board.allCards().find((c) => {
      const wt = this.worktreeAbs(c);
      return wt && (abs === wt || abs.startsWith(wt + path.sep));
    });
  }

  /** 레포 루트, 카드 worktree, 기본 worktree 폴더 안인지 */
  private inRepo(cwd: string | undefined): boolean {
    if (!cwd) return false;
    const abs = path.resolve(cwd);
    const root = this.board.root;
    const worktrees = path.resolve(root, '..', `${path.basename(root)}-worktrees`);
    return [root, worktrees].some((dir) => abs === dir || abs.startsWith(dir + path.sep)) || !!this.cardOfWorktree(cwd);
  }

  /**
   * E-9 ~ E-12: 카드에 연결되지 않은 세션의 첫 요청으로 카드를 판단한다.
   * 첫 요청 전 이벤트와 판단 중에 온 이벤트는 모아 두었다가 연결 뒤에 반영한다.
   */
  private async autoLink(event: AgentEvent, worktreeCardId: string | undefined): Promise<void> {
    const sessionId = event.toolSessionId!;
    const key = `${event.tool}:${sessionId}`;
    const buffered = this.pending.get(key) ?? [];
    if (buffered.length < PENDING_LIMIT) this.pending.set(key, [...buffered, event]);
    const prompt = event.type === 'turn.started' ? event.payload?.prompt?.trim() : undefined;
    if (!prompt || this.linking.has(key)) return;
    this.linking.add(key);
    try {
      const decision = await this.decide(prompt, event.tool, worktreeCardId);
      const result = await this.applyDecision(decision, prompt, event.tool, sessionId);
      const events = this.pending.get(key) ?? [];
      this.pending.delete(key);
      if (!result.linked) {
        await this.addUnlinked(event);
        return;
      }
      for (const e of events) await this.dispatchLinked(e, result.cardId, this.latestRun(result.cardId, 'implementer')?.runId);
    } finally {
      this.linking.delete(key);
    }
  }

  private async cardSummaries(): Promise<CardSummary[]> {
    const cards = this.board.allCards().filter((c) => c.status !== 'done');
    return Promise.all(
      cards.map(async (c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        intent: await readTextIfExists(this.board.taskDocPath(c.id, 'intent')),
        plan: await readTextIfExists(this.board.taskDocPath(c.id, 'plan')),
      })),
    );
  }

  private matcherBinary(sessionTool: ToolId): { tool: ToolId; bin: string } | undefined {
    const setting = this.options.matcherTool();
    if (setting === 'none') return undefined;
    const order: ToolId[] = setting === 'auto' ? ['claude', 'codex', 'cursor', sessionTool] : [setting];
    // ST-9: 꺼진 도구는 판단에 쓰지 않는다.
    const enabled = this.board.enabledTools();
    for (const tool of order.filter((t) => enabled.includes(t))) {
      const bin = this.binaries[tool];
      if (bin) return { tool, bin };
    }
    return undefined;
  }

  /** E-10: worktree·카드 ID 언급 → 분류기 → 키워드 순으로 판단한다. */
  private async decide(prompt: string, sessionTool: ToolId, worktreeCardId: string | undefined): Promise<MatchDecision> {
    const cards = await this.cardSummaries();
    const forced = worktreeCardId ?? explicitMatch(prompt, cards);
    const matcher = this.matcherBinary(sessionTool);
    const text = matcher ? await runClassifier(matcher.tool, matcher.bin, classifierPrompt(prompt, cards)) : undefined;
    const decision = parseClassifierOutput(text, prompt, cards) ?? fallbackDecision(prompt, cards);
    return forced ? { ...decision, cardId: forced, via: 'explicit' } : decision;
  }

  /** E-11, E-12: 카드를 만들거나 문서를 갱신하고, 세션과 사용자에게 알린다. */
  private async applyDecision(
    d: MatchDecision,
    prompt: string,
    tool: ToolId,
    sessionId: string,
  ): Promise<{ linked: false } | { linked: true; cardId: string }> {
    const created = !d.cardId;
    let card = d.cardId ? this.board.getCard(d.cardId) : await this.board.createCard(d.title);
    if (!card) return { linked: false };
    if (created) {
      card = { ...card, agents: { ...card.agents, implementer: { tool } }, updatedAt: new Date().toISOString() };
      await this.board.saveCard(card);
    }

    const paths = { intent: this.board.taskDocPath(card.id, 'intent'), spec: this.board.taskDocPath(card.id, 'spec'), plan: this.board.taskDocPath(card.id, 'plan') };
    const current = {
      intent: (await readTextIfExists(paths.intent)) ?? '',
      spec: (await readTextIfExists(paths.spec)) ?? '',
      plan: (await readTextIfExists(paths.plan)) ?? '',
    };
    const src = { toolName: this.board.t(`tool.${tool}`), sessionId, date: new Date().toISOString().slice(0, 10), locale: this.board.locale };
    const next = created ? fillNewCardDocs(current, d, prompt, src) : addToExistingDocs(current, d, prompt, src);
    for (const doc of ['intent', 'spec', 'plan'] as const) if (next[doc] !== current[doc]) await writeFileAtomic(paths[doc], next[doc]);

    const canvas = this.options.canvasGuide ? { path: path.join(path.dirname(paths.intent), 'canvas.tsx'), guide: this.options.canvasGuide } : undefined;
    await this.store.pushOutbox(tool, sessionId, sessionNotice(card, created, d, paths, canvas));

    // 실행 중인 구현자의 세션은 빼앗지 않는다. 문서 갱신과 세션 알림만 한다.
    const latest = this.latestRun(card.id, 'implementer');
    const busy = !!latest && !latest.external && (latest.status === 'running' || latest.status === 'stopping' || latest.status === 'waiting');
    const params = { tool: src.toolName, id: card.id, title: card.title };
    if (busy) {
      void vscode.window.showWarningMessage(this.board.t('msg.autoLinkBusy', params));
      this.board.refresh();
      return { linked: false };
    }
    await this.serial(() => this.bindUnlocked(card!.id, 'implementer', tool, sessionId, true));
    await this.attachExternal(card.id, 'implementer', tool, sessionId, new Date().toISOString(), card);
    void vscode.window.showInformationMessage(this.board.t(created ? 'msg.autoCreated' : 'msg.autoLinked', params));
    this.board.refresh();
    return { linked: true, cardId: card.id };
  }

  private findBoundCard(tool: ToolId, sessionId: string): { cardId: string; role: Role } | undefined {
    for (const [cardId, roles] of Object.entries(this.sessions)) {
      for (const role of ROLES) {
        const b = roles[role];
        if (b?.tool === tool && b.sessionId === sessionId) return { cardId, role };
      }
    }
    return undefined;
  }

  private findPastRunCard(tool: ToolId, sessionId: string): { cardId: string; role: Role } | undefined {
    const run = this.state.runs.filter((r) => r.tool === tool && r.toolSessionId === sessionId && this.board.getCard(r.cardId)).at(-1);
    return run && { cardId: run.cardId, role: run.role };
  }

  /** 사용자가 직접 시작한 세션을 카드의 실행 회차로 기록한다. */
  private async attachExternal(cardId: string, role: Role, tool: ToolId, sessionId: string, at: string, known?: Card): Promise<void> {
    const card = this.board.getCard(cardId) ?? known;
    if (!card) return;
    await this.bind(cardId, role, tool, sessionId, true);
    await this.serial(async () => {
      const latest = this.latestRun(cardId, role);
      if (latest?.external && latest.toolSessionId === sessionId && !['ended', 'stopped', 'error'].includes(latest.status)) return;
      const record: RunRecord = {
        runId: nextRunId(this.state, cardId),
        cardId,
        role,
        tool,
        toolSessionId: sessionId,
        status: 'waiting',
        startedAt: at,
        branch: card.workspace?.branch,
        worktree: card.workspace?.worktree,
        inputVersions: await this.hashInputs(card),
        lastSeenAt: at,
        lastSeq: {},
        statusVersionAtStart: card.statusVersion,
        external: true,
      };
      this.state = { ...this.state, runs: [...this.state.runs, record] };
      await this.store.saveRuns(this.state);
    });
  }

  private async linkSession(tool: ToolId, sessionId: string): Promise<void> {
    const cardPick = await vscode.window.showQuickPick(
      this.board.allCards().map((c) => ({ label: c.id, description: c.title })),
      { placeHolder: this.board.t('msg.pickCardForSession') },
    );
    if (!cardPick) return;
    const rolePick = await vscode.window.showQuickPick(
      ROLES.map((r) => ({ label: this.board.t(`role.${r}`), role: r })),
      { placeHolder: this.board.t('msg.pickRole') },
    );
    if (!rolePick) return;
    if (!(await this.bind(cardPick.label, rolePick.role, tool, sessionId))) return;
    await this.attachExternal(cardPick.label, rolePick.role, tool, sessionId, new Date().toISOString());
    this.unlinked = this.unlinked.filter((u) => !(u.tool === tool && u.sessionId === sessionId));
    await this.store.saveUnlinked(this.unlinked);
    this.board.refresh();
  }

  /**
   * `agentBoard.linkSession` 명령. 보드 밖(에이전트·다른 확장)에서 세션을 카드 역할에 연결한다.
   * sessions.json을 직접 고치면 메모리의 연결에 반영되지 않으므로 세션 선택과 같은 bind 경로를 탄다.
   */
  async connectSession(cardId: unknown, role: unknown, tool: unknown, sessionId: unknown): Promise<boolean> {
    if (!this.ready) return false;
    await this.ready;
    if (
      typeof cardId !== 'string' ||
      !ROLES.includes(role as Role) ||
      !TOOL_IDS.includes(tool as ToolId) ||
      typeof sessionId !== 'string' ||
      !sessionId
    ) {
      void vscode.window.showWarningMessage(this.board.t('msg.linkSessionArgs'));
      return false;
    }
    const r = role as Role;
    const t = tool as ToolId;
    const card = this.board.getCard(cardId);
    if (!card) {
      void vscode.window.showWarningMessage(this.board.t('msg.cardNotFound', { id: cardId }));
      return false;
    }
    // 역할에 다른 도구가 지정돼 있으면 연결해도 이어 실행할 수 없다 (launch가 무시한다).
    const assigned = card.agents[r]?.tool;
    if (assigned && assigned !== t) {
      void vscode.window.showWarningMessage(
        this.board.t('msg.toolMismatch', { role: this.board.t(`role.${r}`), tool: this.board.t(`tool.${assigned}`) }),
      );
      return false;
    }
    if (!(await this.bind(cardId, r, t, sessionId))) return false;
    if (this.unlinked.some((u) => u.tool === t && u.sessionId === sessionId)) {
      this.unlinked = this.unlinked.filter((u) => !(u.tool === t && u.sessionId === sessionId));
      await this.store.saveUnlinked(this.unlinked);
    }
    await this.postRuns(cardId);
    this.board.refresh();
    void vscode.window.showInformationMessage(
      this.board.t('msg.sessionLinked', { tool: this.board.t(`tool.${t}`), id: cardId, role: this.board.t(`role.${r}`) }),
    );
    return true;
  }

  // ---- Hook ----

  /** Hook 스크립트가 남긴 이벤트를 받은 순서대로 반영한다. */
  processInbox(): Promise<void> {
    this.inboxRun ??= this.drainInbox().finally(() => {
      this.inboxRun = undefined;
    });
    return this.inboxRun;
  }

  private async drainInbox(): Promise<void> {
    for (const item of await this.store.readInbox()) {
      if (item.internal) {
        await this.store.removeInbox(item);
        continue;
      }
      const name = path.basename(item.file, '.json');
      const order = Number(name.split('-')[0]) || Date.parse(item.receivedAt);
      const parsed = TOOL_IDS.includes(item.tool) ? ADAPTERS[item.tool].parseHook(item.input) : [];
      for (const [i, p] of parsed.entries()) {
        await this.dispatch(
          this.toEvent(p, {
            cardId: item.cardId,
            runId: item.runId,
            tool: item.tool,
            source: 'hook',
            seq: order * 100 + i,
            id: `hook:${name}:${i}`,
            at: item.receivedAt,
          }),
        );
      }
      await this.store.removeInbox(item);
    }
  }

  private get hookStateFile(): string {
    return path.join(this.store.localDir, 'hooks.json');
  }

  private async loadHookTools(): Promise<ToolId[]> {
    const text = await readTextIfExists(this.hookStateFile);
    try {
      return text ? ((JSON.parse(text) as { tools: ToolId[] }).tools ?? []) : [];
    } catch {
      return [];
    }
  }

  private async nodeCommand(): Promise<{ node: string; electron: boolean }> {
    const node = await findExecutable(['node']);
    return node ? { node, electron: false } : { node: process.execPath, electron: true };
  }

  /**
   * Hook 명령에는 이 기기의 절대 경로가 들어가므로 Git이 추적하지 않게 `.git/info/exclude`에 넣는다 (S-2).
   * 이미 추적 중인 파일은 덮어쓰지 않고 건너뛴다.
   */
  private async installHooksInto(dir: string, tools: ToolId[]): Promise<{ files: string[]; skipped: string[] }> {
    const result = { files: [] as string[], skipped: [] as string[] };
    if (tools.length === 0) return result;
    const { node, electron } = await this.nodeCommand();
    for (const tool of tools) {
      const rel = HOOK_FILES[tool].split(path.sep).join('/');
      if (await isTracked(dir, rel)) {
        result.skipped.push(path.join(dir, rel));
        continue;
      }
      await addToExclude(dir, [`/${rel}`]).catch(() => undefined);
      result.files.push(await installHooks(dir, tool, hookCommand(node, electron, this.stableHookScript, tool, this.store.inboxDir)));
    }
    return result;
  }

  /** 레포 루트와 카드 worktree에 Hook 설정을 넣는다. 이후 만드는 worktree에도 넣는다. */
  /** Hook 설정이 가리키는 스크립트. 확장 프로그램 설치 폴더는 버전마다 바뀌므로 레포의 local/에 복사해 둔다. */
  private get stableHookScript(): string {
    return path.join(this.store.localDir, 'hook.js');
  }

  /** 확장 프로그램을 업데이트해도 Hook이 끊기지 않도록 시작할 때마다 최신 스크립트로 바꾼다. */
  private async refreshHookScript(): Promise<void> {
    if (!this.hookScript || !(await pathExists(this.hookScript))) return;
    const content = await readTextIfExists(this.hookScript);
    if (content !== undefined && content !== (await readTextIfExists(this.stableHookScript))) {
      await writeFileAtomic(this.stableHookScript, content);
    }
  }

  hooksInstalled(): boolean {
    return this.hookTools.length > 0;
  }

  /** TASK-3 CA-3: 카드 구현자에 연결된 세션에 알림을 남긴다. 연결된 세션이 없으면 false. */
  async notifyImplementer(cardId: string, message: string): Promise<boolean> {
    const binding = this.sessions[cardId]?.implementer;
    if (!binding) return false;
    await this.store.pushOutbox(binding.tool, binding.sessionId, message);
    return true;
  }

  /** 구현자 세션이 있으면 이어서, 없으면 새로 실행한다. */
  async startImplementer(cardId: string, prompt: (card: Card, docs: PromptDocs) => string): Promise<void> {
    const card = this.board.getCard(cardId);
    const tool = card?.agents.implementer?.tool;
    const resume = !!tool && this.sessions[cardId]?.implementer?.tool === tool && ADAPTERS[tool].capabilities.resume;
    await this.startRun(cardId, 'implementer', { resume, prompt });
  }

  /** TASK-3 CV-6: canvas의 openAgent — 세션 ID로 기록된 원문 */
  transcriptForSession(sessionId: string): string | undefined {
    return this.state.runs.filter((r) => r.toolSessionId === sessionId && r.transcriptPath).at(-1)?.transcriptPath;
  }

  /** Hook을 설치한 도구 (TASK-2 ST-4) */
  hookToolList(): ToolId[] {
    return [...this.hookTools];
  }

  /**
   * TASK-2 DS-9: 카드에 연결된 세션과 각 세션의 최신 실행 상태.
   * 실행 회차가 없는 연결은 대기로 본다.
   */
  /**
   * 카드의 에이전트 칩: 세션을 연다. 사용자가 도구에서 연 세션은 그 도구의 채팅 화면에서 연다.
   * 보드가 실행한 CLI 세션은 채팅 목록에 없을 수 있어 worktree 터미널에서 이어 연다.
   */
  private async openSession(cardId: string, tool: ToolId, sessionId: string): Promise<void> {
    const run = runsOfCard(this.state, cardId)
      .filter((r) => r.tool === tool && r.toolSessionId === sessionId)
      .at(-1);
    if (run && !run.external && ACTIVE.has(run.status)) {
      // 실행 중인 세션을 이어 열면 같은 세션에 두 곳에서 입력하게 된다.
      void vscode.window.showInformationMessage(this.board.t('msg.sessionBusy'));
      return;
    }
    if ((!run || run.external) && (await openInToolUi(tool, sessionId))) return;
    const binary = this.binaries[tool];
    if (!binary) {
      void vscode.window.showWarningMessage(this.board.t('runs.notInstalled', { tool: this.board.t(`tool.${tool}`) }));
      return;
    }
    const worktree = run?.worktree ? path.resolve(this.board.root, run.worktree) : undefined;
    resumeInTerminal(tool, binary, sessionId, worktree && (await pathExists(worktree)) ? worktree : this.board.root);
  }

  cardActivity(cardId: string): CardActivity | undefined {
    return cardActivity(runsOfCard(this.state, cardId), this.seen[cardId], parseReport);
  }

  /** 카드를 열면 그때까지 끝난 실행을 본 것으로 한다. */
  private async markSeen(cardId: string): Promise<void> {
    if (!this.cardActivity(cardId)?.unread) return;
    await this.serial(async () => {
      this.seen = { ...this.seen, [cardId]: new Date().toISOString() };
      await this.store.saveSeen(this.seen);
    });
    this.board.refresh();
  }

  cardSessions(cardId: string): CardSession[] {
    const latest = new Map<string, CardSession>();
    for (const run of runsOfCard(this.state, cardId)) {
      const key = `${run.tool}:${run.toolSessionId ?? `run-${run.runId}`}`;
      latest.delete(key);
      latest.set(key, { tool: run.tool, sessionId: run.toolSessionId, status: run.status, at: run.lastSeenAt });
    }
    for (const role of ROLES) {
      const b = this.sessions[cardId]?.[role];
      if (b && !latest.has(`${b.tool}:${b.sessionId}`)) latest.set(`${b.tool}:${b.sessionId}`, { tool: b.tool, sessionId: b.sessionId, status: 'waiting' });
    }
    // 카드에는 앞의 몇 개만 보이므로 최근 세션이 앞에 온다.
    return [...latest.values()].sort((a, b) => (b.at ?? '\uffff').localeCompare(a.at ?? '\uffff'));
  }

  async installHooksCommand(): Promise<void> {
    await this.refreshHookScript();
    const picks = await vscode.window.showQuickPick(
      TOOL_IDS.map((id) => ({ label: this.board.t(`tool.${id}`), id, picked: this.hookTools.includes(id) || this.hookTools.length === 0 })),
      { canPickMany: true },
    );
    if (!picks || picks.length === 0) return;
    const tools = picks.map((p) => p.id);
    const dirs = [this.board.root];
    for (const card of this.board.allCards()) {
      const wt = this.worktreeAbs(card);
      if (wt && (await pathExists(wt))) dirs.push(wt);
    }
    const files: string[] = [];
    const skipped: string[] = [];
    for (const dir of dirs) {
      const r = await this.installHooksInto(dir, tools);
      files.push(...r.files);
      skipped.push(...r.skipped);
    }
    this.hookTools = tools;
    await writeFileAtomic(this.hookStateFile, toJson({ tools }));
    const rel = (f: string) => path.relative(path.dirname(this.board.root), f);
    void vscode.window.showInformationMessage(this.board.t('msg.hooksInstalled', { files: files.map(rel).join(', ') }));
    if (skipped.length) void vscode.window.showWarningMessage(this.board.t('msg.hooksSkipped', { files: skipped.map(rel).join(', ') }));
  }

  /** 보드를 다시 읽기 전에 Hook 이벤트와 코드 버전을 갱신한다. */
  async beforeReload(): Promise<void> {
    if (!this.ready) return;
    await this.ready;
    await this.processInbox();
    if (Date.now() - this.codeRefsAt < CODE_REF_INTERVAL_MS) return;
    this.codeRefsAt = Date.now();
    await this.refreshCodeRefs();
  }
}
