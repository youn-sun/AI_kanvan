// 실행 회차와 이벤트 처리 (spec 7~9절). VS Code·파일 시스템에 의존하지 않는다.

import type { ReviewSummary } from './status';
import type { Role, RunStatus, ToolId } from './types';

export interface ReviewFinding {
  file?: string;
  line?: number;
  message: string;
  severity?: 'high' | 'medium' | 'low';
}

export interface ReviewResult {
  verdict: 'pass' | 'changes_requested';
  findings: ReviewFinding[];
}

export type EventSource = 'stream' | 'hook' | 'runner';

export interface RunRecord {
  runId: string;
  cardId: string;
  role: Role;
  tool: ToolId;
  toolSessionId?: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  branch?: string;
  worktree?: string;
  baseCommit?: string;
  headCommit?: string;
  /** 실행 시점 문서 콘텐츠 해시. 키는 레포 기준 상대 경로 (M-4) */
  inputVersions: Record<string, string>;
  changes?: string[];
  diff?: string;
  summary?: string;
  verification?: string;
  review?: ReviewResult;
  /** 리뷰 대상 코드 버전: 커밋 SHA 또는 `<sha>+<diff 해시>` (A-3) */
  reviewedRef?: string;
  transcriptPath?: string;
  lastSeenAt: string;
  /** 출처별 마지막으로 처리한 순번 (H-2) */
  lastSeq: Partial<Record<EventSource, number>>;
  /** 요약·검증을 마지막으로 채운 이벤트의 출처별 순번. 늦게 온 이전 응답이 덮어쓰지 않게 한다. */
  textSeq?: Partial<Record<EventSource, number>>;
  process?: { pid: number; startedAt: string };
  /** 회차 시작 시점 카드의 statusVersion (K-3) */
  statusVersionAtStart: number;
  statusDetail?: string;
  /** 사용자가 도구에서 직접 시작한 세션 (E-8) */
  external?: boolean;
  /** 자동 수정·재리뷰 반복 회차 (A-7) */
  loopIteration?: number;
  stopRequestedAt?: string;
}

export const AGENT_EVENT_TYPES = [
  'run.started',
  'turn.started',
  'file.changed',
  'response.completed',
  'input.required',
  'run.ended',
  'run.stopped',
  'run.failed',
  'process.lost',
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentEventPayload {
  summary?: string;
  verification?: string;
  changes?: string[];
  error?: string;
  transcriptPath?: string;
  cwd?: string;
  /** 응답 후 세션이 사용자 입력을 기다리는지 (대화형 세션) */
  idle?: boolean;
  reason?: string;
  /** 사용자가 보낸 요청 원문 (카드 자동 생성·연결용, E-9) */
  prompt?: string;
}

/** spec 9.1 공통 이벤트 형식 */
export interface AgentEvent {
  eventId: string;
  type: AgentEventType;
  tool: ToolId;
  toolSessionId?: string;
  cardId?: string;
  runId?: string;
  source: EventSource;
  seq: number;
  occurredAt: string;
  payload?: AgentEventPayload;
}

export interface RunsState {
  runs: RunRecord[];
  /** 처리한 eventId (H-1) */
  seenEventIds: string[];
}

export const EMPTY_RUNS: RunsState = { runs: [], seenEventIds: [] };
const SEEN_LIMIT = 20000;

export const TERMINAL: ReadonlySet<RunStatus> = new Set(['ended', 'stopped', 'error']);
export const ACTIVE: ReadonlySet<RunStatus> = new Set(['running', 'stopping', 'input_required']);
const REOPEN: ReadonlySet<AgentEvent['type']> = new Set(['run.started', 'turn.started', 'input.required']);

export type RunEffect =
  | { kind: 'reloadDocs'; cardId: string }
  | { kind: 'runFinished'; cardId: string; runId: string }
  | { kind: 'unmatched'; event: AgentEvent };

export interface ApplyResult {
  state: RunsState;
  effects: RunEffect[];
  /** 상태가 바뀐 회차 */
  changed?: RunRecord;
}

/** 이벤트가 속한 회차를 찾는다. runId가 없으면 세션 ID로, 이벤트 발생 시각 이전에 시작한 가장 최근 회차를 고른다 (H-3). */
export function resolveRun(state: RunsState, event: AgentEvent): RunRecord | undefined {
  // 회차 번호는 카드마다 1부터 시작하므로 카드 ID도 함께 비교한다.
  if (event.runId) return state.runs.find((r) => r.runId === event.runId && (!event.cardId || r.cardId === event.cardId));
  if (!event.toolSessionId) return undefined;
  const candidates = state.runs.filter(
    (r) => r.tool === event.tool && r.toolSessionId === event.toolSessionId && r.startedAt <= event.occurredAt,
  );
  return candidates.sort(compareRunsByStart).at(-1);
}

function nextStatus(current: RunStatus, event: AgentEvent): RunStatus {
  switch (event.type) {
    case 'run.started':
      return current === 'waiting' ? 'running' : current;
    case 'turn.started':
      return current === 'input_required' || current === 'waiting' ? 'running' : current;
    case 'input.required':
      return current === 'running' ? 'input_required' : current;
    case 'response.completed':
      return event.payload?.idle && current === 'running' ? 'input_required' : current;
    case 'run.ended':
      return current === 'stopping' ? 'stopped' : 'ended';
    case 'run.stopped':
      return 'stopped';
    case 'run.failed':
      return 'error';
    case 'process.lost':
      return 'unknown';
    case 'file.changed':
      return current;
  }
}

export function applyEvent(state: RunsState, event: AgentEvent): ApplyResult {
  // H-1: 같은 eventId는 한 번만 처리한다.
  if (state.seenEventIds.includes(event.eventId)) return { state, effects: [] };
  const seenEventIds = [...state.seenEventIds, event.eventId].slice(-SEEN_LIMIT);
  const run = resolveRun(state, event);
  // 보드 밖 세션은 끝난 뒤에도 다시 이어 쓰므로, 새 요청이 오면 새 회차로 기록하게 한다.
  const resumed = run?.external && !event.runId && TERMINAL.has(run.status) && REOPEN.has(event.type);
  if (!run || resumed) return { state: { ...state, seenEventIds }, effects: [{ kind: 'unmatched', event }] };

  const effects: RunEffect[] = [];
  const next: RunRecord = { ...run, lastSeenAt: maxIso(run.lastSeenAt, event.occurredAt) };
  const p = event.payload ?? {};
  const hasText = p.summary !== undefined || p.verification !== undefined || (event.type === 'response.completed' && !!p.reason);
  const textSeq = run.textSeq?.[event.source];
  if (hasText && (textSeq === undefined || event.seq > textSeq)) {
    if (p.summary !== undefined) next.summary = p.summary;
    if (p.verification !== undefined) next.verification = p.verification;
    if (event.type === 'response.completed' && p.reason) next.statusDetail = p.reason;
    next.textSeq = { ...run.textSeq, [event.source]: event.seq };
  }
  if (p.transcriptPath && !next.transcriptPath) next.transcriptPath = p.transcriptPath;
  if (p.changes) next.changes = [...new Set([...(next.changes ?? []), ...p.changes])];
  if (event.toolSessionId && !next.toolSessionId) next.toolSessionId = event.toolSessionId;
  if (event.type === 'file.changed') effects.push({ kind: 'reloadDocs', cardId: run.cardId });

  // H-2: 출처별 순번이 이미 처리한 값 이하이면 상태를 바꾸지 않는다. 종료된 회차는 다시 열지 않는다.
  const lastSeq = run.lastSeq[event.source];
  const stale = lastSeq !== undefined && event.seq <= lastSeq;
  if (!stale) {
    next.lastSeq = { ...run.lastSeq, [event.source]: event.seq };
    if (!TERMINAL.has(run.status)) {
      const status = nextStatus(run.status, event);
      if (status !== run.status) {
        next.status = status;
        if (TERMINAL.has(status)) {
          next.endedAt = event.occurredAt;
          effects.push({ kind: 'runFinished', cardId: run.cardId, runId: run.runId });
        }
        if (status === 'error' || status === 'unknown') next.statusDetail = p.error ?? p.reason;
      }
    }
  }

  const runs = state.runs.map((r) => (r === run ? next : r));
  return { state: { runs, seenEventIds }, effects, changed: next };
}

/** H-5: 이벤트 로그를 처음부터 다시 적용한다. */
export function replay(initial: RunsState, events: AgentEvent[]): RunsState {
  return events.reduce((s, e) => applyEvent(s, e).state, initial);
}

function compareRunsByStart(a: RunRecord, b: RunRecord): number {
  return a.startedAt === b.startedAt ? Number(a.runId) - Number(b.runId) : a.startedAt < b.startedAt ? -1 : 1;
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

export function runsOfCard(state: RunsState, cardId: string): RunRecord[] {
  return state.runs.filter((r) => r.cardId === cardId).sort((a, b) => Number(a.runId) - Number(b.runId));
}

/** R-1: 역할별 최신 회차 상태. */
export function latestRunStatus(state: RunsState, cardId: string): Partial<Record<Role, RunStatus>> {
  const out: Partial<Record<Role, RunStatus>> = {};
  for (const r of runsOfCard(state, cardId)) out[r.role] = r.status;
  return out;
}

export function nextRunId(state: RunsState, cardId: string): string {
  return String(runsOfCard(state, cardId).reduce((max, r) => Math.max(max, Number(r.runId)), 0) + 1);
}

export function lastReview(state: RunsState, cardId: string): RunRecord | undefined {
  return runsOfCard(state, cardId)
    .filter((r) => r.role === 'reviewer' && r.review)
    .at(-1);
}

/** 마지막 리뷰 결과와 현재 코드 버전으로 재리뷰 필요 여부를 계산한다 (A-5). */
export function reviewSummaryOf(state: RunsState, cardId: string, currentRef: string | undefined): ReviewSummary {
  const review = lastReview(state, cardId);
  if (!review?.review) return { lastPassed: false, rereviewRequired: false };
  return {
    lastPassed: review.review.verdict === 'pass',
    rereviewRequired: currentRef !== undefined && review.reviewedRef !== undefined && review.reviewedRef !== currentRef,
  };
}

export type LoopDecision =
  | { kind: 'none' }
  | { kind: 'fix'; iteration: number; findings: ReviewFinding[] }
  | { kind: 'review'; iteration: number }
  | { kind: 'limit'; max: number }
  | { kind: 'conflict' };

/**
 * A-6, A-7: 회차가 끝난 뒤 자동 수정·재리뷰의 다음 단계를 정한다.
 * - 리뷰가 수정 필요 → 구현자 수정 (한도 도달 시 limit, 같은 지적 연속 2회 시 conflict)
 * - 반복 중인 구현자 수정이 정상 종료 → 재리뷰
 */
export function nextLoopStep(state: RunsState, finished: RunRecord, maxIterations: number): LoopDecision {
  if (finished.status !== 'ended') return { kind: 'none' };
  if (finished.role === 'implementer') {
    return finished.loopIteration ? { kind: 'review', iteration: finished.loopIteration } : { kind: 'none' };
  }
  if (finished.review?.verdict !== 'changes_requested') return { kind: 'none' };
  const iteration = (finished.loopIteration ?? 0) + 1;
  const reviews = runsOfCard(state, finished.cardId).filter((r) => r.role === 'reviewer' && r.review);
  const previous = reviews.filter((r) => Number(r.runId) < Number(finished.runId)).at(-1);
  if (previous?.review?.verdict === 'changes_requested' && sameFindings(previous.review, finished.review)) {
    return { kind: 'conflict' };
  }
  if (iteration > maxIterations) return { kind: 'limit', max: maxIterations };
  return { kind: 'fix', iteration, findings: finished.review.findings };
}

function normalizeFindings(r: ReviewResult): string {
  return r.findings
    .map((f) => `${f.file ?? ''}:${f.line ?? ''}:${f.message.trim().toLowerCase().replace(/\s+/g, ' ')}`)
    .sort()
    .join('\n');
}

export function sameFindings(a: ReviewResult, b: ReviewResult): boolean {
  return a.findings.length > 0 && normalizeFindings(a) === normalizeFindings(b);
}
