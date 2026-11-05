import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { CATEGORY_COLORS, TOOL_IDS, type Category, type CategoryColor, type ToolId } from '../core/types';
import type { BoardState, MachineSettings } from '../shared/protocol';
import { onMessage, send, useT } from './vscode';

type Errors = Record<string, string>;

/** TASK-2 ST-1 ~ ST-8: 보드 설정 화면. 항목마다 팀 공유인지 이 기기 설정인지 표시한다. */
export function Settings({ state, onClose }: { state: BoardState; onClose: () => void }) {
  const t = useT();
  const [errors, setErrors] = useState<Errors>({});

  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type === 'settingError') setErrors((e) => ({ ...e, [msg.field]: msg.message }));
      }),
    [],
  );
  const clearError = (field: string) =>
    setErrors((e) => {
      const next = { ...e };
      delete next[field];
      return next;
    });
  // ST-8: board.json을 읽지 못하면 팀 공유 항목은 바꾸지 않는다.
  const sharedReadOnly = !!state.boardError || !state.board;

  return (
    <div className="settings">
      <header className="board-header">
        <button onClick={onClose}>← {t('settings.back')}</button>
        <h1>{t('settings.title')}</h1>
      </header>
      {state.boardError && (
        <div className="warnings" role="alert">
          {t(state.boardError === 'conflict' ? 'board.boardConflict' : 'board.boardInvalid')}
        </div>
      )}
      <CategoriesSection state={state} readOnly={sharedReadOnly} errors={errors} clearError={clearError} />
      <AgentsSection state={state} readOnly={sharedReadOnly} />
      <ReviewSection state={state} readOnly={sharedReadOnly} errors={errors} clearError={clearError} />
      <AutoCreateSection machine={state.machine} />
      <JiraSection state={state} readOnly={sharedReadOnly} />
    </div>
  );
}

function Section({ title, scope, hint, children }: { title: string; scope: 'shared' | 'machine' | 'mixed'; hint?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2 className="section-title">{title}</h2>
        {scope !== 'mixed' && <ScopeLabel scope={scope} />}
      </div>
      {hint && <p className="muted">{hint}</p>}
      {children}
    </section>
  );
}

function ScopeLabel({ scope }: { scope: 'shared' | 'machine' }) {
  const t = useT();
  return <span className={`scope ${scope}`}>{t(scope === 'shared' ? 'settings.shared' : 'settings.machine')}</span>;
}

/** 값을 입력하는 동안은 로컬 상태로 두고, 포커스를 잃거나 Enter를 누르면 저장한다. */
function CommitInput({
  value,
  onCommit,
  ...props
}: { value: string; onCommit: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      {...props}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function ColorSelect({ value, onChange, disabled, label }: { value: CategoryColor; onChange: (c: CategoryColor) => void; disabled?: boolean; label: string }) {
  const t = useT();
  return (
    <span className="color-select">
      <i className={`dot cat-${value}`} aria-hidden />
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as CategoryColor)}>
        {CATEGORY_COLORS.map((c) => (
          <option key={c} value={c}>
            {t(`color.${c}`)}
          </option>
        ))}
      </select>
    </span>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <span className="field-error" role="alert">
      {message}
    </span>
  ) : null;
}

function CategoriesSection({ state, readOnly, errors, clearError }: { state: BoardState; readOnly: boolean; errors: Errors; clearError: (f: string) => void }) {
  const t = useT();
  const categories = state.board?.categories ?? [];
  const [tag, setTag] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState<CategoryColor>(CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length]!);

  return (
    <Section title={t('settings.categories')} scope="shared" hint={t('settings.categoriesHint')}>
      <table className="settings-table">
        <thead>
          <tr>
            <th>{t('settings.color')}</th>
            <th>{t('settings.tag')}</th>
            <th>{t('settings.name')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {categories.map((c, i) => (
            <CategoryRow key={c.tag} category={c} first={i === 0} last={i === categories.length - 1} readOnly={readOnly} error={errors[`category:${c.tag}`]} clearError={clearError} />
          ))}
        </tbody>
      </table>
      <form
        className="settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          clearError('category');
          send({ type: 'addCategory', tag, name: name || tag, color });
          setTag('');
          setName('');
        }}
      >
        <ColorSelect value={color} onChange={setColor} disabled={readOnly} label={t('settings.color')} />
        <input value={tag} placeholder={t('settings.tag')} aria-label={t('settings.tag')} disabled={readOnly} onChange={(e) => setTag(e.target.value)} />
        <input value={name} placeholder={t('settings.name')} aria-label={t('settings.name')} disabled={readOnly} onChange={(e) => setName(e.target.value)} />
        <button className="primary" type="submit" disabled={readOnly || !tag.trim()}>
          + {t('settings.add')}
        </button>
        <FieldError message={errors.category} />
      </form>
    </Section>
  );
}

function CategoryRow({
  category,
  first,
  last,
  readOnly,
  error,
  clearError,
}: {
  category: Category;
  first: boolean;
  last: boolean;
  readOnly: boolean;
  error?: string;
  clearError: (f: string) => void;
}) {
  const t = useT();
  const example = `## [${category.tag}] `;
  return (
    <tr>
      <td>
        <ColorSelect
          value={category.color}
          disabled={readOnly}
          label={`${category.name} ${t('settings.color')}`}
          onChange={(color) => send({ type: 'updateCategory', tag: category.tag, color })}
        />
      </td>
      <td>
        {/* ST-2: 태그는 plan.md에 쓰이므로 바꿀 수 없다. */}
        <code title={t('settings.tagReadonly')}>{category.tag}</code>
      </td>
      <td>
        <CommitInput
          value={category.name}
          aria-label={`${category.tag} ${t('settings.name')}`}
          disabled={readOnly}
          onCommit={(name) => {
            clearError(`category:${category.tag}`);
            send({ type: 'updateCategory', tag: category.tag, name });
          }}
        />
        <FieldError message={error} />
      </td>
      <td className="row-actions">
        <button title={example} onClick={() => void navigator.clipboard?.writeText(example)}>
          {t('settings.copyExample')}
        </button>
        <button aria-label={t('settings.moveUp')} disabled={readOnly || first} onClick={() => send({ type: 'moveCategory', tag: category.tag, offset: -1 })}>
          ↑
        </button>
        <button aria-label={t('settings.moveDown')} disabled={readOnly || last} onClick={() => send({ type: 'moveCategory', tag: category.tag, offset: 1 })}>
          ↓
        </button>
        <button className="danger" disabled={readOnly} onClick={() => send({ type: 'deleteCategory', tag: category.tag })}>
          {t('settings.delete')}
        </button>
      </td>
    </tr>
  );
}

function AgentsSection({ state, readOnly }: { state: BoardState; readOnly: boolean }) {
  const t = useT();
  const enabled = state.board?.enabledTools ?? [];
  const paths = state.machine.toolPaths;
  const setPath = (tool: ToolId, value: string) => {
    const next = { ...paths };
    if (value.trim()) next[tool] = value.trim();
    else delete next[tool];
    send({ type: 'setMachineSetting', key: 'toolPaths', value: next });
  };
  return (
    <Section title={t('settings.agents')} scope="mixed">
      <table className="settings-table">
        <thead>
          <tr>
            <th />
            <th>
              {t('settings.enabled')} <ScopeLabel scope="shared" />
            </th>
            <th>
              {t('settings.path')} <ScopeLabel scope="machine" />
            </th>
            <th>
              {t('settings.hooks')} <ScopeLabel scope="machine" />
            </th>
          </tr>
        </thead>
        <tbody>
          {TOOL_IDS.map((tool) => {
            const info = state.tools.find((x) => x.id === tool);
            const hooked = state.hookTools.includes(tool);
            return (
              <tr key={tool}>
                <td>
                  <strong>{t(`tool.${tool}`)}</strong>
                  <div className="muted small">{info?.installed ? t('settings.installed', { version: info.version ?? '' }) : t('settings.notInstalled')}</div>
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${t(`tool.${tool}`)} ${t('settings.enabled')}`}
                    checked={enabled.includes(tool)}
                    disabled={readOnly}
                    onChange={(e) => send({ type: 'setToolEnabled', tool, enabled: e.target.checked })}
                  />
                </td>
                <td>
                  <CommitInput
                    value={paths[tool] ?? ''}
                    placeholder={t('settings.pathPlaceholder')}
                    aria-label={`${t(`tool.${tool}`)} ${t('settings.path')}`}
                    onCommit={(v) => setPath(tool, v)}
                  />
                </td>
                <td>
                  {hooked ? (
                    <span className="badge ok">{t('settings.hookInstalled')}</span>
                  ) : (
                    <span className="muted small">{t('settings.hookMissing')}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="settings-row">
        <button onClick={() => send({ type: 'detectTools' })}>{t('settings.redetect')}</button>
        <button onClick={() => send({ type: 'installHooks' })}>{t('board.installHooks')}</button>
      </div>
    </Section>
  );
}

function ReviewSection({ state, readOnly, errors, clearError }: { state: BoardState; readOnly: boolean; errors: Errors; clearError: (f: string) => void }) {
  const t = useT();
  const settings = state.board?.settings;
  if (!settings) return null;
  const numberField = (key: 'maxReviewIterations' | 'stopTimeoutSec', min: number, max: number) => (
    <label className="settings-field">
      <span>{t(`settings.${key}`)}</span>
      <CommitInput
        type="number"
        min={min}
        max={max}
        value={String(settings[key])}
        disabled={readOnly}
        onCommit={(v) => {
          clearError(key);
          send({ type: 'updateBoardSettings', patch: { [key]: Number(v) } });
        }}
      />
      <FieldError message={errors[key]} />
    </label>
  );
  return (
    <Section title={t('settings.review')} scope="shared">
      {numberField('maxReviewIterations', 1, 10)}
      {numberField('stopTimeoutSec', 2, 120)}
      <label className="settings-field inline">
        <input
          type="checkbox"
          checked={settings.defaultAutoReview}
          disabled={readOnly}
          onChange={(e) => send({ type: 'updateBoardSettings', patch: { defaultAutoReview: e.target.checked } })}
        />
        {t('settings.defaultAutoReview')}
      </label>
    </Section>
  );
}

function AutoCreateSection({ machine }: { machine: MachineSettings }) {
  const t = useT();
  return (
    <Section title={t('settings.autoCreate')} scope="machine">
      <label className="settings-field inline">
        <input
          type="checkbox"
          checked={machine.autoCreateCards}
          onChange={(e) => send({ type: 'setMachineSetting', key: 'autoCreateCards', value: e.target.checked })}
        />
        {t('settings.autoCreateCards')}
      </label>
      <label className="settings-field">
        <span>{t('settings.matcherTool')}</span>
        <select value={machine.matcherTool} onChange={(e) => send({ type: 'setMachineSetting', key: 'matcherTool', value: e.target.value })}>
          <option value="auto">{t('settings.matcherAuto')}</option>
          {TOOL_IDS.map((tool) => (
            <option key={tool} value={tool}>
              {t(`tool.${tool}`)}
            </option>
          ))}
          <option value="none">{t('settings.matcherNone')}</option>
        </select>
      </label>
    </Section>
  );
}

/** 카드 → Jira 티켓 발급. 사이트·프로젝트는 board.json(팀 공유), 계정·토큰은 이 기기 비밀 저장소에 둔다. */
function JiraSection({ state, readOnly }: { state: BoardState; readOnly: boolean }) {
  const t = useT();
  const jira = state.board?.jira;
  const save = (site: string, projectKey: string) => send({ type: 'setJiraSettings', site, projectKey });
  return (
    <Section title={t('settings.jira')} scope="mixed" hint={t('settings.jiraHint')}>
      <div className="field-row">
        <label className="field">
          <span>
            {t('settings.jiraSite')} <ScopeLabel scope="shared" />
          </span>
          <CommitInput value={jira?.site ?? ''} placeholder="example.atlassian.net" disabled={readOnly} onCommit={(v) => save(v, jira?.projectKey ?? '')} />
        </label>
        <label className="field">
          <span>
            {t('settings.jiraProject')} <ScopeLabel scope="shared" />
          </span>
          <CommitInput value={jira?.projectKey ?? ''} placeholder="FDE" disabled={readOnly} onCommit={(v) => save(jira?.site ?? '', v)} />
        </label>
      </div>
      <div className="inline">
        <ScopeLabel scope="machine" />
        <span className="muted">{state.jiraAccount ? t('settings.jiraAccount', { email: state.jiraAccount }) : t('settings.jiraNoAccount')}</span>
        <button disabled={!jira} onClick={() => send({ type: 'jiraConnect' })}>
          {t('settings.jiraConnect')}
        </button>
        {state.jiraAccount && <button onClick={() => send({ type: 'jiraDisconnect' })}>{t('settings.jiraDisconnect')}</button>}
      </div>
    </Section>
  );
}
