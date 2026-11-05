import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  blocking,
  issueUrl,
  lintTicket,
  servicesOf,
  similarIssues,
  ticketMarkdown,
  ticketSummary,
  type JiraIssueRef,
  type JiraIssueType,
  type TicketDraft,
} from '../core/jira';
import type { Card } from '../core/types';
import type { BoardState, CardView } from '../shared/protocol';
import { ApprovalControl } from './Approval';
import { onMessage, send, useT } from './vscode';

interface Loaded {
  draft: TicketDraft;
  types: JiraIssueType[];
  recent: JiraIssueRef[];
}

/** 다른 탭에 다녀와도 고치던 초안을 잃지 않게 카드별로 둔다. */
const drafts = new Map<string, Loaded>();

/**
 * 카드 → Jira 티켓. 카드 문서로 채운 초안을 고치고, 형식 검사를 통과하면 그대로 등록한다.
 * 아래 미리보기가 Jira에 들어갈 내용과 같다.
 */
export function JiraTab({ view, card, state }: { view: CardView; card: Card; state: BoardState }) {
  const dir = view.dir;
  const t = useT();
  const settings = state.board?.jira;
  const [loaded, setLoadedState] = useState<Loaded | undefined>(() => drafts.get(dir));
  const setLoaded = (next: Loaded) => {
    drafts.set(dir, next);
    setLoadedState(next);
  };
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [key, setKey] = useState('');

  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type === 'jiraDraft' && msg.dir === dir) {
          setLoading(false);
          setError(msg.error);
          if (msg.draft && msg.types) setLoaded({ draft: msg.draft, types: msg.types, recent: msg.recent ?? [] });
        }
        if (msg.type === 'jiraResult' && msg.dir === dir) {
          setCreating(false);
          setError(msg.error);
          if (msg.key) drafts.delete(dir);
        }
      }),
    [dir],
  );

  const load = () => {
    setLoading(true);
    setError(undefined);
    send({ type: 'jiraDraft', dir });
  };

  if (!settings) return <p className="muted">{t('jira.needSettings')}</p>;
  if (!state.jiraAccount) return <p className="muted">{t('jira.needAccount')}</p>;

  if (card.jira) {
    const url = issueUrl(settings, card.jira.key);
    return (
      <div className="jira">
        <div className="field">
          <span>{t('jira.linked')}</span>
          <strong className="card-id">{card.jira.key}</strong>
        </div>
        <div className="actions start">
          <button className="primary" onClick={() => send({ type: 'openExternal', href: url })}>
            {t('jira.open')}
          </button>
          <button onClick={() => send({ type: 'jiraUnlink', dir })}>{t('jira.unlink')}</button>
        </div>
      </div>
    );
  }

  const linkForm = (
    <form
      className="jira-link"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) send({ type: 'jiraLink', dir, key });
      }}
    >
      <span className="muted">{t('jira.linkExisting')}</span>
      <input value={key} placeholder={t('jira.keyPlaceholder')} onChange={(e) => setKey(e.target.value)} />
      <button type="submit" disabled={!key.trim()}>
        {t('jira.linkThis')}
      </button>
    </form>
  );

  // 승인한 카드만 초안을 만들고 등록할 수 있다. 확장에서도 같은 조건으로 막는다.
  const approved = view.approval === 'approved';

  if (!loaded || !approved) {
    return (
      <div className="jira">
        <ApprovalControl view={view} card={card} />
        {error && <div className="warnings" role="alert">{error}</div>}
        <div className="actions start">
          <button className="primary" disabled={loading || !approved} onClick={load}>
            {loading ? t('jira.loading') : t('jira.makeDraft')}
          </button>
        </div>
        {linkForm}
      </div>
    );
  }

  return (
    <DraftForm
      dir={dir}
      loaded={loaded}
      onChange={(draft) => setLoaded({ ...loaded, draft })}
      onReload={load}
      creating={creating}
      onCreate={() => {
        setCreating(true);
        setError(undefined);
        send({ type: 'jiraCreate', dir, draft: loaded.draft });
      }}
      error={error}
      linkForm={linkForm}
    />
  );
}

function DraftForm({
  dir,
  loaded,
  onChange,
  onReload,
  onCreate,
  creating,
  error,
  linkForm,
}: {
  dir: string;
  loaded: Loaded;
  onChange: (d: TicketDraft) => void;
  onReload: () => void;
  onCreate: () => void;
  creating: boolean;
  error?: string;
  linkForm: ReactNode;
}) {
  const t = useT();
  const { draft: d, types, recent } = loaded;
  const set = (patch: Partial<TicketDraft>) => onChange({ ...d, ...patch });
  const type = types.find((x) => x.id === d.typeId);
  const issues = lintTicket(d, types);
  const services = useMemo(() => servicesOf(recent), [recent]);
  const similar = similarIssues(d, recent);

  return (
    <div className="jira">
      <div className="field-row">
        <label className="field">
          <span>{t('jira.type')}</span>
          <select value={d.typeId} onChange={(e) => set({ typeId: e.target.value })}>
            {!type && <option value="">{t('jira.choose')}</option>}
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        {/* 유형마다 Jira가 꼭 고르라고 하는 선택 필드 (예: 작업의 업무 구분) */}
        {type?.fields.map((f) => (
          <label key={f.id} className="field">
            <span>{f.name}</span>
            <select value={d.fieldValues[f.id] ?? ''} onChange={(e) => set({ fieldValues: { ...d.fieldValues, [f.id]: e.target.value } })}>
              <option value="">{t('jira.choose')}</option>
              {f.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="field-row">
        <label className="field jira-service">
          <span>{t('jira.service')}</span>
          <input list={`jira-services-${dir}`} value={d.service} onChange={(e) => set({ service: e.target.value })} />
          <datalist id={`jira-services-${dir}`}>
            {services.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="field jira-title">
          <span>{t('jira.title')}</span>
          <input value={d.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
      </div>
      <TextField label={t('jira.background')} value={d.background} onChange={(background) => set({ background })} />
      <TextField label={t('jira.todo')} value={d.todo} onChange={(todo) => set({ todo })} />
      <TextField label={t('jira.criteria')} value={d.criteria} onChange={(criteria) => set({ criteria })} />
      <div className="field-row">
        <label className="inline">
          <input type="checkbox" checked={d.review} onChange={(e) => set({ review: e.target.checked })} />
          {t('jira.review')}
        </label>
        <label className="inline">
          <input type="checkbox" checked={d.deploy} onChange={(e) => set({ deploy: e.target.checked })} />
          {t('jira.deploy')}
        </label>
      </div>
      <TextField label={t('jira.notes')} value={d.notes} rows={2} onChange={(notes) => set({ notes })} />

      {similar.length > 0 && (
        <div className="field notice">
          <span>{t('jira.similar')}</span>
          <ul className="jira-similar">
            {similar.map((i) => (
              <li key={i.key}>
                <span className="card-id">{i.key}</span> {i.summary}
                {i.status && <span className="badge">{i.status}</span>}
                <button onClick={() => send({ type: 'jiraLink', dir, key: i.key })}>{t('jira.linkThis')}</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {issues.length > 0 && (
        <ul className="jira-lint" aria-live="polite">
          {issues.map((i, n) => (
            <li key={n} className={i.level}>
              {t(`jira.lint.${i.code}`, i.field ? { field: i.field } : undefined)}
            </li>
          ))}
        </ul>
      )}

      <div className="field">
        <span>{t('jira.preview')}</span>
        <pre className="jira-preview">{`${ticketSummary(d)}\n\n${ticketMarkdown(d)}`}</pre>
      </div>

      {error && <div className="warnings" role="alert">{error}</div>}
      <div className="actions">
        <button onClick={onReload}>{t('jira.reload')}</button>
        <button className="primary" disabled={blocking(issues) || creating} onClick={onCreate}>
          {creating ? t('jira.creating') : t('jira.create')}
        </button>
      </div>
      {linkForm}
    </div>
  );
}

function TextField({ label, value, onChange, rows = 4 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
