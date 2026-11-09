import { useEffect, useMemo, useState } from 'react';
import { TOOL_IDS, type SharedDoc, type ToolId } from '../core/types';
import { ruleSections, sectionTools, type RuleSection } from '../core/agentRules';
import type { BoardState, CanvasActionMessage, RuleFileView } from '../shared/protocol';
import { CanvasFrame } from './canvas/runtime';
import { ConflictBanner, EditableMarkdown } from './DocEditing';
import { onMessage, send, useT } from './vscode';

type RuleDoc = SharedDoc & { rule: NonNullable<SharedDoc['rule']> };
const NO_STATE: Record<string, unknown> = {};

/** AI 규칙: 규칙 문서 하나를 Claude·Codex·Cursor가 읽는 파일로 넘긴다. */
export function RulesPage({ state, onBack, onOpenDoc }: { state: BoardState; onBack: () => void; onOpenDoc: (id: string) => void }) {
  const t = useT();
  const rules = (state.board?.sharedDocs ?? []).filter((d): d is RuleDoc => !!d.rule);
  const [selected, setSelected] = useState<string | undefined>(rules[0]?.id);
  const current = rules.find((r) => r.id === selected) ?? rules[0];
  const { files, importable, duplicates } = state.rules;
  const fileState = (id: string) => {
    const mine = files.filter((f) => f.ruleIds.includes(id));
    return mine.some((f) => f.state !== 'ok') ? 'warn' : mine.length ? 'ok' : 'none';
  };
  const scopes = [...new Set(rules.map((r) => r.rule.scope))].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  const name = (id: string) => rules.find((r) => r.id === id)?.name ?? id;
  const problems = files.filter((f) => f.state !== 'ok');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (e.key === 'Escape' && !typing) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  return (
    <div className="card-page rules-page" aria-label={t('rules.title')}>
      <header className="card-page-bar">
        <button className="link-button" onClick={onBack}>
          ← {t('page.back')}
        </button>
        <strong>{t('rules.title')}</strong>
        <span className="muted">{t('rules.summary', { rules: rules.length, files: files.length })}</span>
        <span className="spacer" />
        {importable.length > 0 && (
          <button onClick={() => send({ type: 'importRules' })}>{t('rules.importN', { n: importable.length })}</button>
        )}
        <button className="primary" onClick={() => send({ type: 'addRule' })}>
          + {t('rules.add')}
        </button>
      </header>
      <div className="rules-layout">
        <aside className="rules-side">
          {importable.length > 0 && (
            <div className="rules-alert">
              {t('rules.importHint', { files: importable.join(', ') })}{' '}
              <button className="link" onClick={() => send({ type: 'importRules' })}>
                {t('rules.import')}
              </button>
            </div>
          )}
          {duplicates.map(([a, b]) => (
            <div key={`${a}:${b}`} className="rules-alert">
              {t('rules.duplicate', { a: name(a), b: name(b) })}{' '}
              <button className="link" onClick={() => send({ type: 'mergeRules', keep: a, drop: b })}>
                {t('rules.merge')}
              </button>
            </div>
          ))}
          {problems.map((f) => (
            <div key={f.path} className="rules-alert">
              {t(f.state === 'edited' ? 'rules.editedHint' : 'rules.unmanagedHint', { path: f.path })}{' '}
              <button className="link" onClick={() => send({ type: 'compareRuleFile', path: f.path })}>
                {t('rules.compare')}
              </button>{' '}
              ·{' '}
              <button className="link" onClick={() => send({ type: 'overwriteRuleFile', path: f.path })}>
                {t('rules.overwrite')}
              </button>
            </div>
          ))}
          {rules.length === 0 && <p className="muted">{t('rules.empty')}</p>}
          {scopes.map((scope) => (
            <div key={scope || '.'}>
              <div className="rules-group">
                <span>{scope ? t('rules.scopeFolder', { scope }) : t('rules.scopeAll')}</span>
              </div>
              {rules
                .filter((r) => r.rule.scope === scope)
                .map((r) => {
                  const st = fileState(r.id);
                  return (
                    <button key={r.id} className={`rule-row${r.id === current?.id ? ' selected' : ''}`} onClick={() => setSelected(r.id)}>
                      <span className="rule-row-title">
                        <span>
                          {r.name}
                          {r.rule.local && <span className="muted"> · {t('rules.local')}</span>}
                        </span>
                        {st !== 'none' && <span className={`badge ${st}`}>{t(st === 'ok' ? 'rules.synced' : 'rules.check')}</span>}
                      </span>
                      <span className="rule-tools">
                        {TOOL_IDS.map((tool) => (
                          <span key={tool} className={`rule-tool${r.rule.tools.includes(tool) ? '' : ' off'}`}>
                            {t(`tool.${tool}`)}
                          </span>
                        ))}
                      </span>
                    </button>
                  );
                })}
            </div>
          ))}
        </aside>
        {current && <RuleDetail key={current.id} rule={current} files={files.filter((f) => f.ruleIds.includes(current.id))} onOpenDoc={onOpenDoc} />}
      </div>
    </div>
  );
}

function RuleDetail({ rule, files, onOpenDoc }: { rule: RuleDoc; files: RuleFileView[]; onOpenDoc: (id: string) => void }) {
  const t = useT();
  const source = useRuleSource(rule.id);
  const [mode, setMode] = useState<'doc' | 'side'>('doc');
  const host = useMemo(() => {
    const dir = `shared:${rule.id}`;
    return {
      setState: (key: string, value: unknown) => send({ type: 'canvasState', dir, key, value }),
      dispatch: (action: CanvasActionMessage) => send({ type: 'canvasAction', dir, action }),
      openLink: (href: string) => send({ type: 'openExternal', href }),
    };
  }, [rule.id]);
  return (
    <section className="rules-main">
      <div className="rules-content">
        <div className="rules-head">
          <h2>{rule.name}</h2>
          <code>{rule.path}</code>
          <span className="spacer" />
          <div className="segmented" role="group">
            {(['doc', 'side'] as const).map((m) => (
              <button key={m} className={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {t(`rules.mode.${m}`)}
              </button>
            ))}
          </div>
        </div>
        <p className="muted rules-section-hint">{t('rules.sectionHint')}</p>
        <ConflictBanner dir={`shared:${rule.id}`} />
        {source === undefined ? (
          <p className="muted">{t('canvas.loading')}</p>
        ) : (
          <CanvasFrame state={NO_STATE} host={host}>
            {mode === 'doc' ? <RuleDocument rule={rule} source={source} /> : <RuleSideBySide rule={rule} source={source} />}
          </CanvasFrame>
        )}
      </div>
      <aside className="rules-info">
        <RuleSettings rule={rule} files={files} onOpenDoc={onOpenDoc} />
      </aside>
    </section>
  );
}

function RuleSettings({ rule, files, onOpenDoc }: { rule: RuleDoc; files: RuleFileView[]; onOpenDoc: (id: string) => void }) {
  const t = useT();
  const [scope, setScope] = useState(rule.rule.scope);
  const toggle = (tool: ToolId) => {
    const tools = rule.rule.tools.includes(tool) ? rule.rule.tools.filter((x) => x !== tool) : [...rule.rule.tools, tool];
    send({ type: 'updateRule', id: rule.id, tools });
  };
  return (
    <>
      <div className="rules-fields">
        <span className="muted">{t('rules.tools')}</span>
        {TOOL_IDS.map((tool) => (
          <label key={tool} className="inline">
            <input type="checkbox" checked={rule.rule.tools.includes(tool)} onChange={() => toggle(tool)} />
            {t(`tool.${tool}`)}
          </label>
        ))}
        <label className="inline">
          <span className="muted">{t('rules.scope')}</span>
          <input
            value={scope}
            placeholder={t('rules.scopeAll')}
            onChange={(e) => setScope(e.target.value)}
            onBlur={() => scope !== rule.rule.scope && send({ type: 'updateRule', id: rule.id, scope })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </label>
        <label className="inline" title={t('rules.localHint')}>
          <input type="checkbox" checked={!!rule.rule.local} onChange={(e) => send({ type: 'updateRule', id: rule.id, local: e.target.checked })} />
          {t('rules.local')}
        </label>
        {rule.rule.local && <span className="muted rule-file-how">{t('rules.localHint')}</span>}
      </div>
      <div className="rules-actions">
        <button className="primary" onClick={() => onOpenDoc(rule.id)}>
          {t('rules.edit')}
        </button>
        <button onClick={() => send({ type: 'openSharedDoc', id: rule.id })}>{t('detail.openInEditor')}</button>
        <button onClick={() => send({ type: 'renameSharedDoc', id: rule.id })}>{t('rules.rename')}</button>
        <span className="spacer" />
        <button className="danger" onClick={() => send({ type: 'removeRule', id: rule.id })}>
          {t('rules.remove')}
        </button>
      </div>
      <h3 className="rules-files-title">{t('rules.files')}</h3>
      {files.length === 0 && <p className="muted">{t('rules.noFiles')}</p>}
      {files.map((f) => (
        <div key={f.path} className="rule-file">
          <div className="rule-file-head">
            <button className="link" onClick={() => send({ type: 'openRuleFile', path: f.path })}>
              <code>{f.path}</code>
            </button>
            <span className="muted">{t(`tool.${f.tool}`)}</span>
            <span className={`badge ${f.state === 'ok' ? 'ok' : 'warn'}`}>{t(`rules.state.${f.state}`)}</span>
            {f.local && <span className="badge">{t('rules.local')}</span>}
          </div>
          <div className="muted rule-file-how">{t(f.local ? `rules.howLocal.${f.tool}` : `rules.how.${f.tool}`)}</div>
          {f.ruleIds.length > 1 && <div className="muted rule-file-how">{t('rules.sharedFile', { n: f.ruleIds.length })}</div>}
        </div>
      ))}
    </>
  );
}

function useRuleSource(id: string): string | undefined {
  const dir = `shared:${id}`;
  const [source, setSource] = useState<string>();
  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === 'canvas' && msg.payload.dir === dir) setSource(msg.payload.markdown ?? '');
    });
    send({ type: 'loadCanvas', dir });
    return () => {
      off();
      send({ type: 'unwatchCanvas', dir });
    };
  }, [dir]);
  return source;
}

function SectionTools({ rule, section, source }: { rule: RuleDoc; section: RuleSection; source: string }) {
  const t = useT();
  const all = rule.rule.tools;
  const on = sectionTools(section, all);
  const label =
    on.length === 0
      ? t('rules.sectionNone')
      : on.length === all.length
        ? t('rules.sectionCommon')
        : t('rules.sectionOnly', { tools: on.map((x) => t(`tool.${x}`)).join('·') });
  const toggle = (tool: ToolId) => {
    const next = all.filter((x) => (x === tool ? !on.includes(x) : on.includes(x)));
    send({ type: 'setRuleSection', id: rule.id, line: section.line, tools: next.length === all.length ? null : next, base: source });
  };
  return (
    <div className="rule-section-bar">
      <span className={`rule-section-label${on.length === all.length ? ' common' : ''}`}>{label}</span>
      {all.length > 1 &&
        all.map((tool) => (
          <button
            key={tool}
            className={`rule-chip${on.includes(tool) ? ' on' : ''}`}
            aria-pressed={on.includes(tool)}
            title={t(on.includes(tool) ? 'rules.chipOff' : 'rules.chipOn', { tool: t(`tool.${tool}`) })}
            onClick={() => toggle(tool)}
          >
            {t(`tool.${tool}`)}
          </button>
        ))}
    </div>
  );
}

function SectionBody({ rule, section, source }: { rule: RuleDoc; section: RuleSection; source: string }) {
  return <EditableMarkdown dir={`shared:${rule.id}`} target="markdown" source={source} range={[section.line, section.end]} />;
}

function RuleDocument({ rule, source }: { rule: RuleDoc; source: string }) {
  const sections = ruleSections(source);
  if (sections.length === 0) return <EditableMarkdown dir={`shared:${rule.id}`} target="markdown" source={source} />;
  return (
    <div className="rule-doc">
      {sections.map((s) => {
        const on = sectionTools(s, rule.rule.tools);
        return (
          <div key={`${s.line}:${s.title}`} className={`rule-section${on.length < rule.rule.tools.length ? ' partial' : ''}`}>
            {s.title && <SectionTools rule={rule} section={s} source={source} />}
            <SectionBody rule={rule} section={s} source={source} />
          </div>
        );
      })}
    </div>
  );
}

/** 도구를 열로 놓고, 여러 도구에 들어가는 절은 그 열들을 가로질러 한 칸으로 보여 준다. */
function RuleSideBySide({ rule, source }: { rule: RuleDoc; source: string }) {
  const t = useT();
  const tools = rule.rule.tools;
  if (tools.length === 0) return <p className="muted">{t('rules.noFiles')}</p>;
  const sections = ruleSections(source);
  const cells: JSX.Element[] = [];
  sections.forEach((s, row) => {
    const gridRow = row + 2;
    const key = `${s.line}:${s.title}`;
    if (!s.title) {
      cells.push(
        <div key={key} className="rule-cell" style={{ gridRow, gridColumn: `1 / span ${tools.length}` }}>
          <div className="rule-section-bar">
            <span className="rule-section-label common">{t('rules.preamble')}</span>
          </div>
          <SectionBody rule={rule} section={s} source={source} />
        </div>,
      );
      return;
    }
    const on = sectionTools(s, tools);
    for (let c = 0; c < tools.length; ) {
      const tool = tools[c]!;
      if (!on.includes(tool)) {
        cells.push(
          <div key={`${key}:${tool}`} className="rule-cell empty" style={{ gridRow, gridColumn: c + 1 }}>
            <span className="muted">{s.title}</span>
            <button
              className="link"
              onClick={() =>
                send({
                  type: 'setRuleSection',
                  id: rule.id,
                  line: s.line,
                  tools: on.length + 1 === tools.length ? null : tools.filter((x) => x === tool || on.includes(x)),
                  base: source,
                })
              }
            >
              + {t('rules.addTo', { tool: t(`tool.${tool}`) })}
            </button>
          </div>,
        );
        c += 1;
        continue;
      }
      let span = 1;
      while (c + span < tools.length && on.includes(tools[c + span]!)) span += 1;
      cells.push(
        <div key={`${key}:${tool}`} className={`rule-cell${span > 1 ? ' shared' : ''}`} style={{ gridRow, gridColumn: `${c + 1} / span ${span}` }}>
          <SectionTools rule={rule} section={s} source={source} />
          <SectionBody rule={rule} section={s} source={source} />
        </div>,
      );
      c += span;
    }
  });
  return (
    <div className="rule-grid" style={{ gridTemplateColumns: `repeat(${tools.length}, minmax(0, 1fr))` }}>
      {tools.map((tool, c) => (
        <div key={tool} className="rule-grid-head" style={{ gridRow: 1, gridColumn: c + 1 }}>
          {t(`tool.${tool}`)}
        </div>
      ))}
      {cells}
    </div>
  );
}
