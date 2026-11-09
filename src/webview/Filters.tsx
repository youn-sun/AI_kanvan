import { useEffect, useRef, useState } from 'react';
import { KANBAN_STATUSES, type KanbanStatus } from '../core/types';
import type { BoardState } from '../shared/protocol';
import { columnCounts, daysAgo, hiddenStatuses, matchesFilter, needsAttention, placedCards, type BoardFilter } from './cards';
import { BellIcon } from './icons';
import { useT } from './vscode';

/** TASK-2 DS-3, DS-4: 구분 칩과 Done 열 완료 시작일 */
export function Filters({ state, filter, onChange }: { state: BoardState; filter: BoardFilter; onChange: (f: BoardFilter) => void }) {
  const t = useT();
  const categories = state.board?.categories ?? [];
  const attention = placedCards(state).filter(needsAttention).length;
  const starred = placedCards(state).filter((v) => v.card.starred).length;
  return (
    <div className="filters">
      {(attention > 0 || filter.attention) && (
        <button
          className={`chip attention${filter.attention ? ' active' : ''}`}
          aria-pressed={!!filter.attention}
          onClick={() => onChange({ ...filter, attention: !filter.attention || undefined })}
        >
          <BellIcon />
          {t('filter.attention', { n: attention })}
        </button>
      )}
      {(starred > 0 || filter.starred) && (
        <button
          className={`chip starred${filter.starred ? ' active' : ''}`}
          aria-pressed={!!filter.starred}
          onClick={() => onChange({ ...filter, starred: !filter.starred || undefined })}
        >
          ★ {t('filter.starred', { n: starred })}
        </button>
      )}
      <div className="chips" role="radiogroup" aria-label={t('filter.categories')}>
        <button
          role="radio"
          aria-checked={!filter.category}
          className={`chip${!filter.category ? ' active' : ''}`}
          onClick={() => onChange({ ...filter, category: undefined })}
        >
          {t('filter.all')}
        </button>
        {categories.map((c) => (
          <button
            key={c.tag}
            role="radio"
            aria-checked={filter.category === c.tag}
            className={`chip${filter.category === c.tag ? ' active' : ''}`}
            onClick={() => onChange({ ...filter, category: c.tag })}
          >
            <i className={`dot cat-${c.color}`} aria-hidden />
            {c.name}
          </button>
        ))}
      </div>
      <ColumnsMenu state={state} filter={filter} onChange={onChange} />
      <label className="done-since">
        <span className="muted">{t('filter.doneSince')}</span>
        <input type="date" value={filter.doneSince ?? ''} onChange={(e) => onChange({ ...filter, doneSince: e.target.value || undefined })} />
      </label>
      <button className="chip" onClick={() => onChange({ ...filter, doneSince: daysAgo(7) })}>
        {t('filter.last7')}
      </button>
    </div>
  );
}

function ColumnsMenu({ state, filter, onChange }: { state: BoardState; filter: BoardFilter; onChange: (f: BoardFilter) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const categories = state.board?.categories ?? [];
  const counts = columnCounts(placedCards(state).filter((c) => matchesFilter(c, filter, categories)));
  const hidden = hiddenStatuses(filter, counts);
  const manual = filter.hiddenColumns ?? [];
  const toggle = (s: KanbanStatus) => {
    const next = manual.includes(s) ? manual.filter((x) => x !== s) : [...manual, s];
    onChange({ ...filter, hiddenColumns: next.length ? next : undefined });
  };
  return (
    <div className="columns-menu" ref={ref}>
      <button className={`chip${hidden.size ? ' active' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('filter.columns', { shown: KANBAN_STATUSES.length - hidden.size, total: KANBAN_STATUSES.length })} ▾
      </button>
      {open && (
        <div className="columns-pop" role="menu">
          {KANBAN_STATUSES.map((s) => (
            <label key={s} className={`columns-row${hidden.has(s) ? ' off' : ''}`}>
              <input type="checkbox" checked={!manual.includes(s)} onChange={() => toggle(s)} />
              <span>{t(`status.${s}`)}</span>
              <span className="count">{counts[s]}</span>
            </label>
          ))}
          <hr />
          <label className="columns-row">
            <input
              type="checkbox"
              checked={!!filter.autoHideEmpty}
              onChange={() => onChange({ ...filter, autoHideEmpty: !filter.autoHideEmpty || undefined })}
            />
            <span>{t('filter.autoHideEmpty')}</span>
          </label>
          <div className="columns-hint">{t('filter.autoHideHint')}</div>
          <hr />
          <button className="link" onClick={() => onChange({ ...filter, hiddenColumns: undefined, autoHideEmpty: undefined })}>
            {t('filter.showAllColumns')}
          </button>
        </div>
      )}
    </div>
  );
}
