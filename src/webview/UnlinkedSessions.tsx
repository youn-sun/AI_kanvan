import type { BoardState } from '../shared/protocol';
import { send, useT } from './vscode';

/** E-8: worktree로 카드를 판별하지 못한 세션. */
export function UnlinkedSessions({ state }: { state: BoardState }) {
  const t = useT();
  if (state.unlinkedSessions.length === 0) return null;
  return (
    <div className="warnings">
      <strong>{t('sessions.unlinked')}</strong>
      {state.unlinkedSessions.map((s) => {
        const act = (action: 'open' | 'newCard' | 'dismiss') => send({ type: 'unlinkedSession', action, tool: s.tool, sessionId: s.sessionId });
        return (
          <div key={`${s.tool}:${s.sessionId}`} className="warning-row unlinked-row">
            <span className="unlinked-title" title={s.prompt ?? s.cwd}>
              {s.prompt ? s.prompt.split('\n')[0] : <span className="muted">{t('sessions.noPrompt')}</span>}
            </span>
            <span className="muted">
              {t(`tool.${s.tool}`)} <code>{s.sessionId.slice(0, 8)}</code>
            </span>
            <button onClick={() => act('open')}>{t('sessions.open')}</button>
            <button onClick={() => send({ type: 'linkSession', tool: s.tool, sessionId: s.sessionId })}>{t('sessions.link')}</button>
            <button onClick={() => act('newCard')}>{t('sessions.newCard')}</button>
            <button title={t('sessions.dismissHint')} onClick={() => act('dismiss')}>
              {t('sessions.dismiss')}
            </button>
          </div>
        );
      })}
    </div>
  );
}
