// 보드 요약 지표, 구분별 진척, 일정·선행 관계 검증 (TASK-2 spec). VS Code에 의존하지 않는다.

import type { ChecklistItem } from './checklist';
import { CATEGORY_COLORS, type BoardSettings, type Card, type Category, type Progress } from './types';

/** 미분류 항목의 키 */
export const UNCLASSIFIED = '';

/** 태그(소문자) → 진행률. 미분류는 UNCLASSIFIED 키를 쓴다. */
export type TagProgress = Record<string, Progress>;

export function tagProgress(items: ChecklistItem[]): TagProgress {
  const out: TagProgress = {};
  for (const item of items) {
    if (item.dropped) continue;
    const keys = item.tags?.length ? [...new Set(item.tags.map((t) => t.toLowerCase()))] : [item.tag?.toLowerCase() ?? UNCLASSIFIED];
    for (const key of keys) {
      const p = (out[key] ??= { done: 0, total: 0 });
      p.total += 1;
      if (item.checked) p.done += 1;
    }
  }
  return out;
}

function categoryOf(tag: string, categories: Category[]): Category | undefined {
  return categories.find((c) => c.tag.toLowerCase() === tag);
}

/** CT-3: 보드에 없는 태그를 미분류로 합친다. */
export function normalizeTags(tags: TagProgress, categories: Category[]): TagProgress {
  const out: TagProgress = {};
  for (const [tag, p] of Object.entries(tags)) {
    const key = tag !== UNCLASSIFIED && categoryOf(tag, categories) ? tag : UNCLASSIFIED;
    const acc = (out[key] ??= { done: 0, total: 0 });
    acc.done += p.done;
    acc.total += p.total;
  }
  return out;
}

/** CT-3: 보드에 없는 태그 목록 (원래 표기). */
export function unknownTags(items: ChecklistItem[], categories: Category[]): string[] {
  const seen = new Set<string>();
  for (const item of items)
    for (const tag of item.tags ?? (item.tag ? [item.tag] : [])) if (!categoryOf(tag.toLowerCase(), categories)) seen.add(tag);
  return [...seen];
}

/** CT-4: 카드의 구분 태그. 보드 구분 순서를 따른다. */
export function cardCategories(tags: TagProgress, categories: Category[]): Category[] {
  return categories.filter((c) => (tags[c.tag.toLowerCase()]?.total ?? 0) > 0);
}

export interface BoardMetrics {
  items: Progress;
  todo: number;
  active: number;
  done: number;
}

/** DS-1: 진행 작업은 In Progress와 Review를 합친다. */
export function boardMetrics(cards: { card: Card; progress: Progress }[]): BoardMetrics {
  const m: BoardMetrics = { items: { done: 0, total: 0 }, todo: 0, active: 0, done: 0 };
  for (const { card, progress } of cards) {
    m.items.done += progress.done;
    m.items.total += progress.total;
    if (card.status === 'todo') m.todo += 1;
    else if (card.status === 'in_progress' || card.status === 'review') m.active += 1;
    else if (card.status === 'done') m.done += 1;
  }
  return m;
}

export interface CategoryRow {
  category?: Category;
  progress: Progress;
}

/** DS-2: 항목이 있는 구분만, 보드 순서대로. 미분류는 마지막. */
export function categoryProgress(cards: { tags: TagProgress }[], categories: Category[]): CategoryRow[] {
  const sum: TagProgress = {};
  for (const { tags } of cards) {
    for (const [tag, p] of Object.entries(normalizeTags(tags, categories))) {
      const acc = (sum[tag] ??= { done: 0, total: 0 });
      acc.done += p.done;
      acc.total += p.total;
    }
  }
  const rows: CategoryRow[] = categories
    .map((category) => ({ category, progress: sum[category.tag.toLowerCase()] ?? { done: 0, total: 0 } }))
    .filter((r) => r.progress.total > 0);
  const rest = sum[UNCLASSIFIED];
  if (rest && rest.total > 0) rows.push({ progress: rest });
  return rows;
}

// ---- 날짜 ----

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** 이 기기 시간대의 날짜 `YYYY-MM-DD` */
export function localDate(at: Date | string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Done 카드의 완료 시각. 기록이 없는 기존 카드는 updatedAt (CD-2). */
export function completedAt(card: Card): string | undefined {
  return card.status === 'done' ? (card.doneAt ?? card.updatedAt) : undefined;
}

/** DS-8: 마감일을 넘긴 날수. 넘기지 않았거나 마감일이 없으면 0. */
export function overdueDays(card: Card, today: string): number {
  if (!card.dueDate || !isDate(card.dueDate)) return 0;
  const end = card.status === 'done' ? localDate(completedAt(card)!) : today;
  return Math.max(0, daysBetween(card.dueDate, end));
}

export type DateError = 'invalid_start' | 'invalid_due' | 'start_after_due';

/** CD-4 */
export function validateDates(startDate: string | undefined, dueDate: string | undefined): DateError | undefined {
  if (startDate && !isDate(startDate)) return 'invalid_start';
  if (dueDate && !isDate(dueDate)) return 'invalid_due';
  if (startDate && dueDate && startDate > dueDate) return 'start_after_due';
  return undefined;
}

// ---- 선행 관계 ----

export type DependencyError = 'self' | 'unknown' | 'cycle';

/** CD-3: 같은 보드 카드만, 자기 자신·순환 금지. */
export function validateDependencies(cardId: string, dependsOn: string[], cards: Card[]): DependencyError | undefined {
  if (dependsOn.includes(cardId)) return 'self';
  const byId = new Map(cards.map((c) => [c.id, c]));
  if (dependsOn.some((id) => !byId.has(id))) return 'unknown';
  // cardId에서 출발해 선행 관계를 따라가다 다시 cardId에 닿으면 순환이다.
  const edges = (id: string) => (id === cardId ? dependsOn : (byId.get(id)?.dependsOn ?? []));
  const seen = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === cardId) return 'cycle';
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...edges(id));
  }
  return undefined;
}

// ---- 설정 ----

const TAG = /^[A-Za-z0-9_-]{1,20}$/;

export type CategoryError = 'invalid_tag' | 'duplicate_tag' | 'invalid_name' | 'invalid_color';

/** CT-0 */
export function validateCategory(c: Category, existing: Category[]): CategoryError | undefined {
  if (!TAG.test(c.tag)) return 'invalid_tag';
  if (existing.some((e) => e.tag.toLowerCase() === c.tag.toLowerCase())) return 'duplicate_tag';
  const name = c.name.trim();
  if (name.length < 1 || name.length > 30) return 'invalid_name';
  if (!CATEGORY_COLORS.includes(c.color)) return 'invalid_color';
  return undefined;
}

export const SETTING_RANGES = {
  maxReviewIterations: [1, 10],
  stopTimeoutSec: [2, 120],
} as const;

/** ST-5: 범위를 벗어난 값은 거부한다. */
export function validateSettings(patch: Partial<BoardSettings>): keyof typeof SETTING_RANGES | undefined {
  for (const key of Object.keys(SETTING_RANGES) as (keyof typeof SETTING_RANGES)[]) {
    const v = patch[key];
    if (v === undefined) continue;
    const [min, max] = SETTING_RANGES[key];
    if (!Number.isInteger(v) || v < min || v > max) return key;
  }
  return undefined;
}
