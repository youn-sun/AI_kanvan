import { useEffect, useRef, useState } from 'react';
import { localDate } from '../core/board';
import { formatProgress } from '../core/checklist';
import { ROLES, TASK_DOCS, TOOL_IDS, type Card, type Role, type TaskDoc, type ToolId } from '../core/types';
import type { BoardState, CardPatch, CardView } from '../shared/protocol';
import { categoriesOf, placedCards } from './cards';
import { CanvasTab } from './CanvasTab';
import { DocEditor } from './DocEditor';
import { ApprovalControl } from './Approval';
import { JiraTab } from './JiraTab';
import { Runs } from './Runs';
import { send, useT } from './vscode';

type Tab = 'canvas' | 'overview' | TaskDoc | 'runs' | 'jira';

/**
 * TASK-3 CP-1 ~ CP-3: 카드를 누르면 보드 대신 전체 화면으로 열리는 카드 화면.
 * 맨 위 줄에 뒤로·작업 ID·수정일·브랜치·마감일을 두고, canvas가 있으면 문서 탭부터 보여 준다.
 */
export function CardPage({ view, state, onBack }: { view: CardView; state: BoardState; onBack: () => void }) {
  const t = useT();
  // 모든 카드는 문서(canvas 스타일)부터 보여 준다. canvas.tsx가 없으면 기본 문서가 나온다.
  const [tab, setTab] = useState<Tab>('canvas');
  const card = view.card;

  // 카드를 열면 끝난 실행을 본 것으로 한다.
  useEffect(() => send({ type: 'markSeen', dir: view.dir }), [view.dir]);

  // CP-1: 입력 중이 아닐 때 Esc를 누르면 보드로 돌아간다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (e.key === 'Escape' && !typing) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  if (!card) return null;
  // Jira 탭은 보드 설정에 Jira 사이트·프로젝트가 있을 때만 보인다.
  const tabs: Tab[] = ['canvas', 'overview', ...TASK_DOCS, 'runs', ...(state.board?.jira ? (['jira'] as const) : [])];
  const tabLabel = (x: Tab) =>
    x === 'canvas'
      ? t('tab.canvas')
      : x === 'overview'
        ? t('detail.overview')
        : x === 'runs'
          ? t('detail.runs')
          : x === 'jira'
            ? card.jira?.key ?? t('tab.jira')
            : t(`doc.${x}`);

  return (
    <div className="card-page" aria-label={card.id}>
      <header className="card-page-bar">
        <button className="link-button" onClick={onBack}>
          ← {t('page.back')}
        </button>
        <span className="card-id">{card.id}</span>
        <span className="muted">
          {t('page.updated', { date: localDate(card.updatedAt) })} · {card.workspace?.branch ?? t('page.noBranch')}
        </span>
        <label className="inline muted">
          {t('page.due')}
          <input type="date" value={card.dueDate ?? ''} onChange={(e) => send({ type: 'updateCard', id: card.id, patch: { dueDate: e.target.value } })} />
        </label>
        <span className="spacer" />
        <span className="card-page-title">{card.title}</span>
      </header>
      <nav className="tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>
            {tabLabel(x)}
          </button>
        ))}
      </nav>
      <div className={`card-page-body${tab === 'canvas' ? ' canvas-tab' : ''}`}>
        {tab === 'canvas' && <CanvasTab key={view.dir} dir={view.dir} view={view} state={state} />}
        {tab === 'overview' && <Overview view={view} card={card} state={state} />}
        {(tab === 'intent' || tab === 'spec' || tab === 'plan') && <DocEditor key={tab} dir={view.dir} doc={tab} categories={state.board?.categories} />}
        {tab === 'runs' && <Runs view={view} card={card} state={state} />}
        {tab === 'jira' && <JiraTab key={view.dir} view={view} card={card} state={state} />}
      </div>
    </div>
  );
}

function Overview({ view, card, state }: { view: CardView; card: Card; state: BoardState }) {
  const t = useT();
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description ?? '');
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  // 편집 중이 아니면 파일·다른 화면에서 바뀐 값을 따라간다.
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(card.title);
  }, [card.title]);
  useEffect(() => {
    if (document.activeElement !== descriptionRef.current) setDescription(card.description ?? '');
  }, [card.description]);
  // 포커스를 얻을 때의 값과 비교해 실제로 고친 경우에만 저장한다.
  const focusValue = useRef('');
  const update = (patch: CardPatch) => send({ type: 'updateCard', id: card.id, patch });
  const sharedDocs = state.board?.sharedDocs ?? [];
  const enabledTools = state.board?.enabledTools ?? [];
  const cats = categoriesOf(view, state.board?.categories ?? []);
  const dependsOn = card.dependsOn ?? [];
  const others = placedCards(state)
    .map((c) => c.card)
    .filter((c) => c.id !== card.id);

  return (
    <div className="overview">
      <label className="field">
        <span>{t('detail.title')}</span>
        <input
          ref={titleRef}
          value={title}
          onFocus={() => (focusValue.current = title)}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== focusValue.current && update({ title })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <label className="field">
        <span>{t('detail.description')}</span>
        <textarea
          ref={descriptionRef}
          rows={3}
          value={description}
          onFocus={() => (focusValue.current = description)}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== focusValue.current && update({ description })}
        />
      </label>

      <div className="field">
        <span>{t('detail.progress')}</span>
        <strong>{formatProgress(view.progress)}</strong>
      </div>

      <ApprovalControl view={view} card={card} />

      <div className="field">
        <span>{t('detail.categories')}</span>
        <div className="card-line">
          {cats.length === 0 && <span className="muted">{t('detail.noCategories')}</span>}
          {cats.map((c) => (
            <span key={c.tag} className="cat-tag">
              <i className={`dot cat-${c.color}`} aria-hidden />
              {c.name}
            </span>
          ))}
        </div>
        <span className="muted small">{t('detail.categoriesHint')}</span>
      </div>

      <div className="field-row">
        <label className="field">
          <span>{t('detail.startDate')}</span>
          <input type="date" value={card.startDate ?? ''} onChange={(e) => update({ startDate: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('detail.dueDate')}</span>
          <input type="date" value={card.dueDate ?? ''} onChange={(e) => update({ dueDate: e.target.value })} />
        </label>
      </div>

      <fieldset className="field">
        <legend>{t('detail.dependsOn')}</legend>
        {/* CD-3: 같은 보드의 다른 카드만 고를 수 있다. 순환은 저장할 때 거부한다. */}
        <div className="depends-list">
          {others.map((other) => (
            <label key={other.id} className="inline">
              <input
                type="checkbox"
                checked={dependsOn.includes(other.id)}
                onChange={(e) =>
                  update({ dependsOn: e.target.checked ? [...dependsOn, other.id] : dependsOn.filter((d) => d !== other.id) })
                }
              />
              <span className="card-id">{other.id}</span> {other.title}
            </label>
          ))}
        </div>
      </fieldset>

      {card.manualDone && (
        <div className="field notice">
          <span>{t('detail.manualDoneAt', { at: new Date(card.manualDone.at).toLocaleString() })}</span>
          <ul>
            {card.manualDone.unmet.map((u) => (
              <li key={u}>{t(`unmet.${u}`)}</li>
            ))}
          </ul>
        </div>
      )}

      <fieldset className="field">
        <legend>{t('detail.agents')}</legend>
        {ROLES.map((role: Role) => (
          <label key={role} className="inline">
            <span className="label-w">{t(`role.${role}`)}</span>
            <select
              value={card.agents[role]?.tool ?? ''}
              onChange={(e) =>
                update({ agents: { [role]: e.target.value ? { tool: e.target.value as ToolId } : null } })
              }
            >
              <option value="">{t('tool.none')}</option>
              {/* DS-16: 이 보드에서 켠 도구만 고를 수 있다. 꺼진 도구가 이미 지정돼 있으면 표시만 한다. */}
              {TOOL_IDS.filter((tool) => enabledTools.includes(tool) || card.agents[role]?.tool === tool).map((tool) => (
                <option key={tool} value={tool} disabled={!enabledTools.includes(tool)}>
                  {enabledTools.includes(tool) ? t(`tool.${tool}`) : t('tool.disabled', { tool: t(`tool.${tool}`) })}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="inline">
          <input type="checkbox" checked={!!card.autoReview} onChange={(e) => update({ autoReview: e.target.checked })} />
          {t('detail.autoReview')}
        </label>
      </fieldset>

      <fieldset className="field">
        <legend>{t('detail.relatedDocs')}</legend>
        {sharedDocs.length === 0 && <span className="muted">{t('shared.empty')}</span>}
        {sharedDocs.map((doc) => (
          <label key={doc.id} className="inline">
            <input
              type="checkbox"
              checked={card.relatedDocs.includes(doc.id)}
              onChange={(e) =>
                update({
                  relatedDocs: e.target.checked ? [...card.relatedDocs, doc.id] : card.relatedDocs.filter((d) => d !== doc.id),
                })
              }
            />
            {doc.name}
            {state.sharedDocExists[doc.id] === false && <span className="badge error">{t('shared.broken')}</span>}
          </label>
        ))}
      </fieldset>

      <fieldset className="field">
        <legend>{t('detail.workspace')}</legend>
        {card.workspace?.worktree ? (
          <div>
            <code>{card.workspace.branch}</code> · <code>{card.workspace.worktree}</code>
            {view.worktreeMissing && <span className="badge warn">{t('detail.worktreeMissing')}</span>}
          </div>
        ) : (
          <span className="muted">{t('detail.noWorkspace')}</span>
        )}
        {(!card.workspace?.worktree || view.worktreeMissing) && (
          <button onClick={() => send({ type: 'createWorktree', dir: view.dir })}>{t('detail.createWorktree')}</button>
        )}
      </fieldset>

      <div className="actions">
        {view.duplicate && <button onClick={() => send({ type: 'renumberCard', dir: view.dir })}>{t('card.renumber')}</button>}
        <button onClick={() => send({ type: 'openCardFile', dir: view.dir })}>{t('card.openFile')}</button>
        <button className="danger" onClick={() => send({ type: 'deleteCard', dir: view.dir })}>
          {t('card.delete')}
        </button>
      </div>
    </div>
  );
}
