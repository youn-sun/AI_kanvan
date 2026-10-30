import { describe, expect, it } from 'vitest';
import {
  boardMetrics,
  cardCategories,
  categoryProgress,
  normalizeTags,
  overdueDays,
  tagProgress,
  unknownTags,
  validateCategory,
  validateDates,
  validateDependencies,
  validateSettings,
} from '../../src/core/board';
import { parseChecklist } from '../../src/core/checklist';
import { applyRunStatusChange, moveCard } from '../../src/core/status';
import { DEFAULT_CATEGORIES, type Card } from '../../src/core/types';

const plan = [
  '# Plan',
  '- [x] 미분류 하나',
  '## [BE] 로그인 API',
  '- [x] 토큰 발급',
  '- [ ] 갱신',
  '### 세부 (태그 없음)',
  '- [x] 상위 태그를 따른다',
  '## [fe] 화면',
  '- [ ] 로그인 폼',
  '```md',
  '## [Infra] 코드 블록 안',
  '- [ ] 무시',
  '```',
  '## [Docs] 보드에 없는 태그',
  '- [ ] 문서',
  '## 태그 없는 절',
  '- [ ] 다시 미분류',
].join('\n');

const card = (id: string, extra: Partial<Card> = {}): Card => ({
  schemaVersion: 1,
  id,
  title: id,
  status: 'todo',
  statusVersion: 0,
  order: 1,
  agents: {},
  relatedDocs: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

describe('multi-category headings', () => {
  it('counts an item in every tag of its heading', () => {
    const items = parseChecklist(['## [BE][ML] 지역 매핑', '- [x] 별칭 표', '- [ ] 부모 계층', '### 세부', '- [ ] 상속'].join('\n'));
    expect(items.map((i) => i.tags)).toEqual([['BE', 'ML'], ['BE', 'ML'], ['BE', 'ML']]);
    expect(tagProgress(items)).toEqual({ be: { done: 1, total: 3 }, ml: { done: 1, total: 3 } });
  });
});

describe('item categories (CT-1 ~ CT-4)', () => {
  const items = parseChecklist(plan);

  it('inherits the nearest tagged heading and ignores code blocks', () => {
    expect(items.map((i) => i.tag)).toEqual([undefined, 'BE', 'BE', 'BE', 'fe', 'Docs', undefined]);
  });

  it('counts unknown tags as unclassified and lists them', () => {
    const tags = tagProgress(items);
    expect(tags).toEqual({ '': { done: 1, total: 2 }, be: { done: 2, total: 3 }, fe: { done: 0, total: 1 }, docs: { done: 0, total: 1 } });
    expect(normalizeTags(tags, DEFAULT_CATEGORIES)).toEqual({ '': { done: 1, total: 3 }, be: { done: 2, total: 3 }, fe: { done: 0, total: 1 } });
    expect(unknownTags(items, DEFAULT_CATEGORIES)).toEqual(['Docs']);
    expect(cardCategories(tags, DEFAULT_CATEGORIES).map((c) => c.tag)).toEqual(['BE', 'FE']);
  });

  it('does not count struck-through items in tag progress', () => {
    expect(tagProgress(parseChecklist('## [BE] API\n- [x] a\n- [ ] ~~b~~\n'))).toEqual({ be: { done: 1, total: 1 } });
  });

  it('sums categories across cards in board order, unclassified last (DS-2)', () => {
    const rows = categoryProgress([{ tags: tagProgress(items) }, { tags: { ml: { done: 1, total: 1 } } }], DEFAULT_CATEGORIES);
    expect(rows.map((r) => [r.category?.tag ?? '—', r.progress.done, r.progress.total])).toEqual([
      ['BE', 2, 3],
      ['FE', 0, 1],
      ['ML', 1, 1],
      ['—', 1, 3],
    ]);
  });
});

describe('metrics (DS-1)', () => {
  it('counts items and cards; active = In Progress + Review', () => {
    const m = boardMetrics([
      { card: card('a'), progress: { done: 1, total: 4 } },
      { card: card('b', { status: 'in_progress' }), progress: { done: 2, total: 2 } },
      { card: card('c', { status: 'review' }), progress: { done: 0, total: 0 } },
      { card: card('d', { status: 'suspended' }), progress: { done: 0, total: 1 } },
      { card: card('e', { status: 'done' }), progress: { done: 3, total: 3 } },
    ]);
    expect(m).toEqual({ items: { done: 6, total: 10 }, todo: 1, active: 2, done: 1 });
  });
});

describe('dates (DS-8, CD-4)', () => {
  it('counts days past the due date for open and done cards', () => {
    expect(overdueDays(card('a', { dueDate: '2026-10-10' }), '2026-10-20')).toBe(10);
    expect(overdueDays(card('a', { dueDate: '2026-10-25' }), '2026-10-20')).toBe(0);
    expect(overdueDays(card('a'), '2026-10-20')).toBe(0);
    const done = card('a', { status: 'done', dueDate: '2026-10-10', doneAt: new Date(2026, 9, 13, 12).toISOString() });
    expect(overdueDays(done, '2026-12-31')).toBe(3);
  });

  it('validates dates', () => {
    expect(validateDates('2026-10-01', '2026-10-31')).toBeUndefined();
    expect(validateDates('2026-11-01', '2026-10-31')).toBe('start_after_due');
    expect(validateDates('2026-02-30', undefined)).toBe('invalid_start');
    expect(validateDates(undefined, 'tomorrow')).toBe('invalid_due');
  });
});

describe('dependencies (CD-3)', () => {
  const cards = [card('A', { dependsOn: ['B'] }), card('B', { dependsOn: ['C'] }), card('C')];
  it('rejects self, unknown cards and cycles', () => {
    expect(validateDependencies('C', ['C'], cards)).toBe('self');
    expect(validateDependencies('C', ['Z'], cards)).toBe('unknown');
    expect(validateDependencies('C', ['A'], cards)).toBe('cycle');
    expect(validateDependencies('A', ['B', 'C'], cards)).toBeUndefined();
  });
});

describe('settings validation (CT-0, ST-5)', () => {
  it('validates categories', () => {
    expect(validateCategory({ tag: 'Data', name: '데이터', color: 'green' }, DEFAULT_CATEGORIES)).toBeUndefined();
    expect(validateCategory({ tag: 'be', name: 'x', color: 'green' }, DEFAULT_CATEGORIES)).toBe('duplicate_tag');
    expect(validateCategory({ tag: 'B E', name: 'x', color: 'green' }, DEFAULT_CATEGORIES)).toBe('invalid_tag');
    expect(validateCategory({ tag: 'X', name: ' ', color: 'green' }, DEFAULT_CATEGORIES)).toBe('invalid_name');
    expect(validateCategory({ tag: 'X', name: 'x', color: 'pink' as never }, DEFAULT_CATEGORIES)).toBe('invalid_color');
  });

  it('validates ranges', () => {
    expect(validateSettings({ maxReviewIterations: 3, stopTimeoutSec: 30 })).toBeUndefined();
    expect(validateSettings({ maxReviewIterations: 11 })).toBe('maxReviewIterations');
    expect(validateSettings({ stopTimeoutSec: 1.5 })).toBe('stopTimeoutSec');
  });
});

describe('doneAt (CD-2)', () => {
  const now = '2026-10-20T01:00:00.000Z';
  it('is set when entering Done and cleared when leaving', () => {
    const done = moveCard(card('a'), 'done', { now, hasActiveRun: false }).card;
    expect(done.doneAt).toBe(now);
    expect(moveCard(done, 'review', { now, hasActiveRun: false }).card.doneAt).toBeUndefined();
    expect(applyRunStatusChange(card('a', { status: 'review' }), 0, 'done', now)?.doneAt).toBe(now);
  });
});
