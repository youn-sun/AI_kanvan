// 웹뷰에서 쓰는 카드 계산 도우미.

import { cardCategories, completedAt, localDate, normalizeTags } from '../core/board';
import { KANBAN_STATUSES, type Card, type Category, type KanbanStatus, type RunStatus } from '../core/types';
import type { BoardState, CardView } from '../shared/protocol';

export type Placed = CardView & { card: Card };

/** 카드 데이터를 읽은 카드만 (병합 충돌 등으로 읽지 못한 카드 제외) */
export function placedCards(state: BoardState): Placed[] {
  return state.cards.filter((c): c is Placed => !!c.card);
}

export function categoriesOf(view: CardView, categories: Category[]): Category[] {
  return cardCategories(normalizeTags(view.tags, categories), categories);
}

export interface BoardFilter {
  /** 선택한 구분 태그. 없으면 전체 */
  category?: string;
  /** Done 열에 보일 완료 시작일 `YYYY-MM-DD` */
  doneSince?: string;
  /** 사람이 볼 카드만 */
  attention?: boolean;
  /** 중요 표시한 카드만 */
  starred?: boolean;
  /** 직접 숨긴 열 */
  hiddenColumns?: KanbanStatus[];
  /** 카드가 없는 열을 숨긴다. 새 카드 버튼이 있는 할 일 열은 남긴다 */
  autoHideEmpty?: boolean;
}

export function hiddenStatuses(filter: BoardFilter, counts: Record<KanbanStatus, number>): Set<KanbanStatus> {
  return new Set(
    KANBAN_STATUSES.filter((s) => filter.hiddenColumns?.includes(s) || (filter.autoHideEmpty && s !== 'todo' && counts[s] === 0)),
  );
}

export function columnCounts(cards: Placed[]): Record<KanbanStatus, number> {
  const counts = Object.fromEntries(KANBAN_STATUSES.map((s) => [s, 0])) as Record<KanbanStatus, number>;
  for (const c of cards) if (c.card.status in counts) counts[c.card.status] += 1;
  return counts;
}

/** 사람의 입력이나 확인이 필요한 실행 상태 */
export const ATTENTION: ReadonlySet<RunStatus> = new Set(['input_required', 'error', 'unknown']);

/** 에이전트가 기다리거나 실패했거나, 끝난 결과를 아직 안 본 카드 */
export function needsAttention(view: CardView): boolean {
  return view.sessions.some((s) => ATTENTION.has(s.status)) || !!view.activity?.unread;
}

/** 지난 시간을 "방금 / N분 / N시간 / N일" 단위로 나눈다. */
export function elapsed(at: string, now = Date.now()): { unit: 'now' | 'minutes' | 'hours' | 'days'; n: number } {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000));
  if (minutes < 1) return { unit: 'now', n: 0 };
  if (minutes < 60) return { unit: 'minutes', n: minutes };
  if (minutes < 60 * 24) return { unit: 'hours', n: Math.floor(minutes / 60) };
  return { unit: 'days', n: Math.floor(minutes / (60 * 24)) };
}

/** TASK-2 DS-3, DS-4 */
export function matchesFilter(view: Placed, filter: BoardFilter, categories: Category[]): boolean {
  if (filter.category && !categoriesOf(view, categories).some((c) => c.tag === filter.category)) return false;
  if (filter.attention && !needsAttention(view)) return false;
  if (filter.starred && !view.card.starred) return false;
  if (filter.doneSince && view.card.status === 'done') {
    const at = completedAt(view.card);
    if (!at || localDate(at) < filter.doneSince) return false;
  }
  return true;
}

/** 오늘을 포함한 n일 전 날짜 */
export function daysAgo(n: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - (n - 1));
  return localDate(d);
}

/** `YYYY-MM-DD` → `MM-DD` */
export function shortDate(date: string): string {
  return date.slice(5);
}
