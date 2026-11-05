// 보드 데이터 모델. spec.md 1.2·1.3절 참고.

import type { CardApproval } from './approval';
import type { JiraSettings } from './jira';

export const KANBAN_STATUSES = ['todo', 'in_progress', 'review', 'suspended', 'done'] as const;
export type KanbanStatus = (typeof KANBAN_STATUSES)[number];

export const RUN_STATUSES = [
  'waiting',
  'running',
  'input_required',
  'stopping',
  'stopped',
  'ended',
  'error',
  'unknown',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TOOL_IDS = ['claude', 'codex', 'cursor'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export const ROLES = ['implementer', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const DOC_CATEGORIES = ['api', 'convention', 'erd', 'architecture', 'other'] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export const TASK_DOCS = ['intent', 'spec', 'plan'] as const;
export type TaskDoc = (typeof TASK_DOCS)[number];

export const CARD_SCHEMA_VERSION = 1;
export const BOARD_SCHEMA_VERSION = 2;

export interface AgentAssignment {
  tool: ToolId;
  /** 도구별 설정 (모델, 추가 인자 등). 기기 의존 값은 넣지 않는다. */
  options?: Record<string, string>;
}

export type UnmetCondition = 'checklist_incomplete' | 'review_not_passed' | 'rereview_required';

export interface ManualDone {
  at: string;
  unmet: UnmetCondition[];
}

export interface Card {
  schemaVersion: number;
  id: string;
  title: string;
  description?: string;
  status: KanbanStatus;
  statusVersion: number;
  order: number;
  agents: Partial<Record<Role, AgentAssignment>>;
  relatedDocs: string[];
  workspace?: { branch?: string; worktree?: string };
  /** 리뷰어 자동 수정·재리뷰 진행 여부 (A-6) */
  autoReview?: boolean;
  manualDone?: ManualDone;
  /** 시작일 `YYYY-MM-DD` */
  startDate?: string;
  /** 마감일 `YYYY-MM-DD`. 넘기면 D+N을 표시한다 */
  dueDate?: string;
  /** 같은 보드의 선행 카드 ID */
  dependsOn?: string[];
  /** Done으로 옮긴 시각. Done에서 나가면 지운다 */
  doneAt?: string;
  /** 이 카드로 발급했거나 연결한 Jira 티켓 */
  jira?: { key: string };
  /** 사용자가 카드 문서를 확인하고 승인한 기록. 승인한 카드만 Jira 티켓으로 발급한다 */
  approval?: CardApproval;
  createdAt: string;
  updatedAt: string;
}

export interface SharedDoc {
  id: string;
  name: string;
  category: DocCategory;
  /** 레포 루트 기준 상대 경로 */
  path: string;
  /** 보드 구분 태그(BE·FE 등). 공용 문서 표의 "구분" 열 */
  tags?: string[];
}

export interface BoardSettings {
  maxReviewIterations: number;
  stopTimeoutSec: number;
  /** 새 카드의 자동 수정·재리뷰 기본값 */
  defaultAutoReview: boolean;
}

/** 구분 색. 실제 색은 테마별로 웹뷰가 정한다. */
export const CATEGORY_COLORS = ['blue', 'purple', 'mauve', 'orange', 'green', 'teal', 'red', 'yellow'] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];

export interface Category {
  /** plan.md 제목에 쓰는 식별자. 만든 뒤 바꾸지 않는다 */
  tag: string;
  /** 보드에 보이는 이름 */
  name: string;
  color: CategoryColor;
}

export interface BoardConfig {
  schemaVersion: number;
  sharedDocs: SharedDoc[];
  settings: BoardSettings;
  categories: Category[];
  /** 이 보드에서 연결할 수 있는 에이전트 도구 */
  enabledTools: ToolId[];
  /** 카드로 티켓을 발급할 Jira 사이트·프로젝트. 계정·토큰은 기기마다 따로 둔다 */
  jira?: JiraSettings;
}

export const DEFAULT_SETTINGS: BoardSettings = {
  maxReviewIterations: 3,
  stopTimeoutSec: 10,
  defaultAutoReview: false,
};

export const DEFAULT_CATEGORIES: Category[] = [
  { tag: 'BE', name: 'BE', color: 'blue' },
  { tag: 'FE', name: 'FE', color: 'purple' },
  { tag: 'Infra', name: 'Infra', color: 'mauve' },
  { tag: 'ML', name: 'ML', color: 'orange' },
];

export function defaultBoard(): BoardConfig {
  return {
    schemaVersion: BOARD_SCHEMA_VERSION,
    sharedDocs: [],
    settings: { ...DEFAULT_SETTINGS },
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    enabledTools: [...TOOL_IDS],
  };
}

export interface Progress {
  done: number;
  total: number;
}
