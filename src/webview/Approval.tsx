import { localDate } from '../core/board';
import type { Card } from '../core/types';
import type { CardView } from '../shared/protocol';
import { send, useT } from './vscode';

/** 카드 승인. 승인한 카드만 Jira 티켓으로 발급한다. 승인은 지금의 intent.md·spec.md 내용에 묶인다. */
export function ApprovalControl({ view, card }: { view: CardView; card: Card }) {
  const t = useT();
  const state = view.approval;
  return (
    <div className="field approval">
      <span>{t('approval.title')}</span>
      <span className={state === 'changed' ? 'approval-note warn' : 'muted'}>
        {state === 'approved' && card.approval
          ? t('approval.approved', { date: localDate(card.approval.at) })
          : state === 'changed'
            ? t('approval.changed')
            : t('approval.none')}
      </span>
      <div className="actions start">
        {state !== 'approved' && (
          <button className="primary" onClick={() => send({ type: 'approveCard', dir: view.dir })}>
            {t(state === 'changed' ? 'approval.reapprove' : 'approval.approve')}
          </button>
        )}
        {state !== 'none' && <button onClick={() => send({ type: 'revokeApproval', dir: view.dir })}>{t('approval.revoke')}</button>}
      </div>
      <span className="muted small">{t('approval.hint')}</span>
    </div>
  );
}
