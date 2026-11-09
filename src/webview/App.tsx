import { useEffect, useState } from 'react';
import type { BoardState } from '../shared/protocol';
import { Board } from './Board';
import type { BoardFilter } from './cards';
import { CardPage } from './Detail';
import { Filters } from './Filters';
import { RulesPage } from './RulesPage';
import { GearIcon } from './icons';
import { Settings } from './Settings';
import { SharedDocPage } from './SharedDocPage';
import { SharedDocsBar } from './SharedDocsBar';
import { CategoryBars, Summary } from './Summary';
import { UnlinkedSessions } from './UnlinkedSessions';
import { LocaleContext, loadViewState, onMessage, saveViewState, send, useT } from './vscode';

/** 보는 사람의 화면 상태. 공유 파일에 쓰지 않는다 (TASK-2 DS-5). */
interface ViewState {
  view: 'board' | 'settings' | 'card' | 'shared' | 'rules';
  /** view가 card일 때 연 카드 (TASK-3 CP-1) */
  card?: string;
  /** view가 shared일 때 연 공용 문서 ID */
  doc?: string;
  filter: BoardFilter;
}

export function App() {
  const [state, setState] = useState<BoardState>();
  const [viewState, setViewState] = useState<ViewState>(() => loadViewState<ViewState>({ view: 'board', filter: {} }));

  useEffect(() => saveViewState(viewState), [viewState]);

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === 'state') setState(msg.state);
      if (msg.type === 'showSettings') setViewState((v) => ({ ...v, view: 'settings' }));
    });
    send({ type: 'ready' });
    return off;
  }, []);

  if (!state) return null;
  const showView = (view: ViewState['view'], card?: string, doc?: string) => setViewState((v) => ({ ...v, view, card, doc }));
  const openCard = (dir: string) => showView('card', dir);
  const cardView = viewState.view === 'card' ? state.cards.find((c) => c.dir === viewState.card && c.card) : undefined;

  return (
    <LocaleContext.Provider value={state.locale}>
      {!state.initialized ? (
        <InitScreen />
      ) : viewState.view === 'settings' ? (
        <Settings state={state} onClose={() => showView('board')} />
      ) : cardView ? (
        <CardPage key={cardView.dir} view={cardView} state={state} onBack={() => showView('board')} />
      ) : viewState.view === 'shared' && viewState.doc && state.board?.sharedDocs.some((d) => d.id === viewState.doc) ? (
        <SharedDocPage
          key={viewState.doc}
          docId={viewState.doc}
          state={state}
          onBack={() => showView(state.board?.sharedDocs.find((d) => d.id === viewState.doc)?.rule ? 'rules' : 'board')}
        />
      ) : viewState.view === 'rules' ? (
        <RulesPage state={state} onBack={() => showView('board')} onOpenDoc={(id) => showView('shared', undefined, id)} />
      ) : (
        <div className="layout">
          <main className="board-area">
            <BoardHeader onSettings={() => showView('settings')} onRules={() => showView('rules')} />
            <BoardWarnings state={state} />
            <HooksBanner state={state} />
            <UnlinkedSessions state={state} />
            <Summary state={state} />
            <CategoryBars state={state} />
            <Filters state={state} filter={viewState.filter} onChange={(filter) => setViewState((v) => ({ ...v, filter }))} />
            <Board state={state} filter={viewState.filter} onSelect={openCard} onFilter={(filter) => setViewState((v) => ({ ...v, filter }))} />
            <SharedDocsBar state={state} onOpen={(id) => showView('shared', undefined, id)} />
          </main>
        </div>
      )}
    </LocaleContext.Provider>
  );
}

function BoardHeader({ onSettings, onRules }: { onSettings: () => void; onRules: () => void }) {
  const t = useT();
  return (
    <header className="board-header">
      <h1>Agent Board</h1>
      <span className="spacer" />
      <button onClick={onRules}>{t('rules.title')}</button>
      {location.protocol.startsWith('vscode') && (
        <button onClick={() => send({ type: 'openInBrowser' })}>{t('board.openInBrowser')}</button>
      )}
      <button onClick={onSettings} aria-label={t('settings.open')}>
        <GearIcon />
        {t('settings.open')}
      </button>
    </header>
  );
}

function InitScreen() {
  const t = useT();
  return (
    <div className="init">
      <button className="primary" onClick={() => send({ type: 'init' })}>
        {t('board.init')}
      </button>
      <p className="muted">{t('board.initHint')}</p>
    </div>
  );
}

function BoardWarnings({ state }: { state: BoardState }) {
  const t = useT();
  const broken = state.cards.filter((c) => c.error);
  if (!state.boardError && broken.length === 0) return null;
  return (
    <div className="warnings" role="alert">
      {state.boardError && <div>{t(state.boardError === 'conflict' ? 'board.boardConflict' : 'board.boardInvalid')}</div>}
      {broken.map((c) => (
        <div key={c.dir} className="warning-row">
          <strong>{c.dir}</strong> {t(c.error === 'conflict' ? 'card.conflict' : 'card.invalid')}
          {c.errorDetail && <span className="muted"> ({c.errorDetail})</span>}
          <button onClick={() => send({ type: 'openCardFile', dir: c.dir })}>{t('card.openFile')}</button>
        </div>
      ))}
    </div>
  );
}

/** Hook이 없으면 채팅 요청이 카드로 반영되지 않으므로 설치를 권한다 (E-9). */
function HooksBanner({ state }: { state: BoardState }) {
  const t = useT();
  if (state.hooksInstalled) return null;
  return (
    <div className="warnings" role="status">
      <div className="warning-row">
        <span>{t('board.hooksMissing')}</span>
        <button className="primary" onClick={() => send({ type: 'installHooks' })}>
          {t('board.installHooks')}
        </button>
      </div>
    </div>
  );
}
