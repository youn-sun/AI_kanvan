// 확장 프로그램 ↔ 보드 웹뷰 메시지.

import type { TagProgress } from '../core/board';
import type { ChecklistItem } from '../core/checklist';
import type { CardActivity } from '../core/activity';
import type { ImplementerReport, ReportStatus, ToneIssue } from '../core/report';
import type { ReviewResult } from '../core/runs';
import type {
  AgentAssignment,
  BoardConfig,
  BoardSettings,
  Card,
  CategoryColor,
  DocCategory,
  KanbanStatus,
  Progress,
  Role,
  RunStatus,
  TaskDoc,
  ToolId,
} from '../core/types';
import type { Locale } from './i18n';

export interface RunView {
  runId: string;
  role: Role;
  tool: ToolId;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  verification?: string;
  /** 구현자가 낸 보고. 상태 라벨은 보드가 정한다. */
  report?: ImplementerReport & { status: ReportStatus };
  /** 말투 검사에서 고치지 못한 문제 */
  tone: ToneIssue[];
  changes?: string[];
  diff?: string;
  review?: ReviewResult;
  reviewedRef?: string;
  transcriptPath?: string;
  statusDetail?: string;
  inputChanged: boolean;
}

/** 카드에 연결된 세션 하나 (TASK-2 DS-9) */
export interface CardSession {
  tool: ToolId;
  sessionId?: string;
  status: RunStatus;
  /** 마지막 활동 시각. 같은 도구 칩이 여럿일 때 구별한다 */
  at?: string;
}

/** 이 기기 설정 (VS Code 설정, TASK-2 ST-1) */
export interface MachineSettings {
  toolPaths: Partial<Record<ToolId, string>>;
  autoCreateCards: boolean;
  matcherTool: 'auto' | ToolId | 'none';
}

export interface CardView {
  dir: string;
  card?: Card;
  error?: 'conflict' | 'invalid';
  errorDetail?: string;
  progress: Progress;
  /** plan.md 항목의 구분별 진행률 (TASK-2 CT-2) */
  tags: TagProgress;
  sessions: CardSession[];
  /** 마지막 활동 한 줄과 확인 안 한 결과 여부 */
  activity?: CardActivity;
  hasCanvas: boolean;
  duplicate: boolean;
  runStatus: Partial<Record<Role, RunStatus>>;
  rereviewRequired: boolean;
  worktreeMissing: boolean;
}

export interface ToolInfo {
  id: ToolId;
  installed: boolean;
  version?: string;
  capabilities: Record<string, boolean>;
}

export interface BoardState {
  initialized: boolean;
  locale: Locale;
  board?: BoardConfig;
  boardError?: 'conflict' | 'invalid';
  cards: CardView[];
  sharedDocExists: Record<string, boolean>;
  /** 공용 문서 ID → 마지막 변경일과 브랜치 (D-2) */
  sharedDocMeta: Record<string, { date?: string; branch?: string }>;
  tools: ToolInfo[];
  /** 에이전트 세션 Hook 설치 여부. 없으면 채팅 요청이 보드에 반영되지 않는다. */
  hooksInstalled: boolean;
  /** Hook을 설치한 도구 */
  hookTools: ToolId[];
  machine: MachineSettings;
  /** 카드를 판별하지 못한 세션 (E-8) */
  unlinkedSessions: { tool: ToolId; sessionId: string; cwd: string }[];
}

export interface CardPatch {
  title?: string;
  description?: string;
  agents?: Partial<Record<Role, AgentAssignment | null>>;
  relatedDocs?: string[];
  autoReview?: boolean;
  /** 빈 문자열이면 지운다 */
  startDate?: string;
  dueDate?: string;
  dependsOn?: string[];
}

export type ToExtension =
  | { type: 'ready' }
  | { type: 'init' }
  | { type: 'createCard'; title: string }
  | { type: 'updateCard'; id: string; patch: CardPatch }
  | { type: 'moveCard'; id: string; to: KanbanStatus; beforeId?: string; afterId?: string }
  | { type: 'deleteCard'; dir: string }
  | { type: 'renumberCard'; dir: string }
  | { type: 'openCardFile'; dir: string }
  | { type: 'openTaskDoc'; dir: string; doc: TaskDoc }
  | { type: 'watchDoc'; dir: string; doc: TaskDoc }
  | { type: 'unwatchDoc'; dir: string; doc: TaskDoc }
  | { type: 'saveDoc'; dir: string; doc: TaskDoc; content: string; base: string | undefined }
  | { type: 'compareDoc'; dir: string; doc: TaskDoc; content: string }
  | { type: 'toggleChecklist'; dir: string; line: number; text: string; checked: boolean }
  | { type: 'addSharedDoc' }
  | { type: 'openSharedDoc'; id: string }
  | { type: 'renameSharedDoc'; id: string }
  | { type: 'setSharedDocCategory'; id: string; category: DocCategory }
  | { type: 'setSharedDocTags'; id: string; tags: string[] }
  | { type: 'openSession'; dir: string; tool: ToolId; sessionId: string }
  | { type: 'relinkSharedDoc'; id: string }
  | { type: 'removeSharedDoc'; id: string }
  | { type: 'createDocTask'; id: string }
  | { type: 'loadRuns'; dir: string }
  | { type: 'markSeen'; dir: string }
  | { type: 'startRun'; dir: string; role: Role; resume: boolean }
  | { type: 'stopRun'; dir: string; role: Role }
  | { type: 'resolveRun'; dir: string; runId: string; status: 'ended' | 'error' }
  | { type: 'openTranscript'; dir: string; runId: string }
  | { type: 'pickSession'; dir: string; role: Role }
  | { type: 'newSession'; dir: string; role: Role }
  | { type: 'linkSession'; tool: ToolId; sessionId: string }
  | { type: 'requestReview'; dir: string }
  | { type: 'createWorktree'; dir: string }
  | { type: 'installHooks' }
  | { type: 'addCategory'; tag: string; name: string; color: CategoryColor }
  | { type: 'updateCategory'; tag: string; name?: string; color?: CategoryColor }
  | { type: 'moveCategory'; tag: string; offset: -1 | 1 }
  | { type: 'deleteCategory'; tag: string }
  | { type: 'setToolEnabled'; tool: ToolId; enabled: boolean }
  | { type: 'updateBoardSettings'; patch: Partial<BoardSettings> }
  | { type: 'setMachineSetting'; key: 'toolPaths' | 'autoCreateCards' | 'matcherTool'; value: unknown }
  | { type: 'detectTools' }
  | { type: 'loadCanvas'; dir: string }
  | { type: 'unwatchCanvas'; dir: string }
  | { type: 'canvasState'; dir: string; key: string; value: unknown }
  | { type: 'canvasAction'; dir: string; action: CanvasActionMessage }
  | { type: 'canvasError'; dir: string; message: string }
  | { type: 'openExternal'; href: string }
  | { type: 'requestCanvas'; dir: string }
  | { type: 'fixCanvas'; dir: string; error: string }
  | { type: 'createCanvas'; dir: string }
  /** 코드를 보드 옆 칸에 연다. line이 있으면 그 줄로 간다. */
  | { type: 'openCanvasFile'; dir: string; line?: number }
  /**
   * 문서 화면에서 바로 고친 내용. 원문 [start, end)를 text로 바꾼다. 파일이 base와 다르면 고치지 않는다.
   * literal이면 [start, end)는 코드의 문자열이고 text는 새 글자다. 따옴표·이스케이프는 확장 프로그램이 붙인다.
   */
  | { type: 'editDocText'; dir: string; target: DocTarget; base: string; start: number; end: number; text: string; literal?: boolean };

/** 문서 화면에서 고칠 수 있는 파일: 그림·canvas 코드, Markdown 공용 문서, 카드 작업 문서 */
export type DocTarget = 'code' | 'markdown' | TaskDoc;

/** 화면에 보일 수 있는, canvas 코드에 직접 쓴 글자 */
export interface CanvasLiteral {
  start: number;
  end: number;
  /** 1부터 */
  line: number;
  value: string;
  kind: 'string' | 'jsxText' | 'jsxAttr';
  /** 감싼 가장 안쪽 괄호. 값이 같은 글자는 같은 괄호의 다른 글자로 구분한다. */
  group?: number;
}

/** canvas의 useCanvasAction 동작 (TASK-3 CV-6) */
export type CanvasActionMessage =
  | { type: 'openFile'; path: string; selection?: { startLineNumber?: number; startColumn?: number; endLineNumber?: number; endColumn?: number } }
  | { type: 'openAgent'; agentId: string }
  | { type: 'newComposerChat'; userPrompt?: string };

/**
 * 카드 문서 탭·공용 문서 화면에 보낼 문서 (TASK-3 CV-1).
 * `dir`은 카드 ID, 또는 공용 문서면 `shared:<문서 ID>`다.
 */
export interface CanvasPayload {
  dir: string;
  kind: 'card' | 'shared';
  /** canvas.tsx(카드) 또는 공용 문서 파일이 있는지 */
  exists: boolean;
  /** canvas가 없는 카드의 기본 문서용 작업 문서 */
  docs?: { intent?: string; spec?: string; plan?: string };
  /** Markdown 공용 문서 내용 */
  markdown?: string;
  /** 보드에서 그릴 수 없는 공용 문서 (이미지 등) */
  unsupported?: boolean;
  path?: string;
  /** 신뢰하지 않는 작업 공간이면 실행하지 않는다 (CV-9) */
  trusted: boolean;
  /** 페이지 전체 canvas(default export) 또는 md에 끼워 넣는 그림 모음 */
  mode?: 'page' | 'figures';
  /** canvas 코드 원문과 변환 결과. 그림 모음은 카드의 canvas.tsx 또는 Markdown 공용 문서 옆의 `.canvas.tsx`다. */
  source?: string;
  code?: string;
  codePath?: string;
  literals?: CanvasLiteral[];
  /** 그림 이름 → 정의한 줄 */
  figureLines?: Record<string, number>;
  error?: string;
  state: Record<string, unknown>;
  canStart: boolean;
}

export type ToWebview =
  | { type: 'state'; state: BoardState }
  | { type: 'doc'; dir: string; doc: TaskDoc; content: string | undefined }
  | { type: 'docSaved'; dir: string; doc: TaskDoc; content: string }
  | { type: 'docConflict'; dir: string; doc: TaskDoc; fileContent: string | undefined }
  | { type: 'checklist'; dir: string; items: ChecklistItem[] }
  | { type: 'runs'; dir: string; runs: RunView[]; sessions: Partial<Record<Role, string>> }
  | { type: 'showSettings' }
  | { type: 'canvas'; payload: CanvasPayload }
  /** 바로 고치는 사이 파일이 다른 곳에서 바뀌었다 */
  | { type: 'docTextConflict'; dir: string }
  /** 설정 화면 입력 검증 실패 (ST-7) */
  | { type: 'settingError'; field: string; message: string };
