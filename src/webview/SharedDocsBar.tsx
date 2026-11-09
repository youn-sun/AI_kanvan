import { useState } from 'react';
import { DOC_CATEGORIES } from '../core/types';
import type { BoardState } from '../shared/protocol';
import { opensInBoard } from './SharedDocPage';
import { send, useT } from './vscode';

/** D-2: 보드 아래의 공용 문서 표. 문서·일자·브랜치·구분을 보여 준다. */
export function SharedDocsBar({ state, onOpen }: { state: BoardState; onOpen: (id: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState<string>();
  const docs = (state.board?.sharedDocs ?? []).filter((d) => !d.rule);
  const categories = state.board?.categories ?? [];
  const tagName = (tag: string) => categories.find((c) => c.tag === tag)?.name ?? tag;

  return (
    <section className="shared-docs" aria-label={t('shared.title')}>
      <div className="shared-header">
        <h3>
          {t('shared.title')} · {docs.length}
        </h3>
        <button onClick={() => send({ type: 'addSharedDoc' })}>+ {t('shared.add')}</button>
      </div>
      {docs.length === 0 ? (
        <span className="muted">{t('shared.empty')}</span>
      ) : (
        <div className="shared-table-wrap">
          <table className="shared-table">
            <thead>
              <tr>
                <th>{t('shared.colDoc')}</th>
                <th>{t('shared.colDate')}</th>
                <th>{t('shared.colBranch')}</th>
                <th>{t('shared.colTags')}</th>
                <th aria-label={t('shared.actions')} />
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => {
                const broken = state.sharedDocExists[doc.id] === false;
                const meta = state.sharedDocMeta[doc.id];
                const tags = doc.tags ?? [];
                return (
                  <tr key={doc.id} className={broken ? 'broken' : undefined}>
                    <td>
                      <button
                        className="link-button"
                        // canvas·Markdown 문서는 보드 안에서 canvas 스타일로 연다 (TASK-3).
                        onClick={() => (opensInBoard(doc.path) && !broken ? onOpen(doc.id) : send({ type: 'openSharedDoc', id: doc.id }))}
                        title={doc.path}
                      >
                        {doc.name}
                      </button>
                      {broken && <span className="badge error">{t('shared.broken')}</span>}
                    </td>
                    <td>{meta?.date}</td>
                    <td>{meta?.branch}</td>
                    <td>{tags.map(tagName).join(' · ')}</td>
                    <td className="shared-actions">
                      <button aria-expanded={open === doc.id} aria-label={t('shared.actions')} onClick={() => setOpen(open === doc.id ? undefined : doc.id)}>
                        ⋯
                      </button>
                      {open === doc.id && (
                        <div className="shared-menu">
                          <fieldset className="shared-tags">
                            <legend>{t('shared.tags')}</legend>
                            {categories.map((c) => (
                              <label key={c.tag} className="inline">
                                <input
                                  type="checkbox"
                                  checked={tags.includes(c.tag)}
                                  onChange={(e) =>
                                    send({
                                      type: 'setSharedDocTags',
                                      id: doc.id,
                                      tags: e.target.checked ? [...tags, c.tag] : tags.filter((x) => x !== c.tag),
                                    })
                                  }
                                />
                                {c.name}
                              </label>
                            ))}
                          </fieldset>
                          <label className="inline">
                            {t('msg.sharedDocCategory')}
                            <select
                              value={doc.category}
                              onChange={(e) =>
                                send({ type: 'setSharedDocCategory', id: doc.id, category: e.target.value as typeof doc.category })
                              }
                            >
                              {DOC_CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {t(`category.${c}`)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="shared-menu-actions">
                            <button onClick={() => send({ type: 'createDocTask', id: doc.id })}>{t('shared.createTask')}</button>
                            <button onClick={() => send({ type: 'renameSharedDoc', id: doc.id })}>{t('shared.rename')}</button>
                            <button onClick={() => send({ type: 'relinkSharedDoc', id: doc.id })}>{t('shared.relink')}</button>
                            <button className="danger" onClick={() => send({ type: 'removeSharedDoc', id: doc.id })}>
                              {t('shared.remove')}
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
