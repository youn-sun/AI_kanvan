import type { Card } from '../core/types';
import { send, useT } from './vscode';

/** 카드 중요 표시. 표시하지 않은 카드에서는 카드에 마우스를 올렸을 때만 보인다. */
export function StarToggle({ card }: { card: Card }) {
  const t = useT();
  const label = t(card.starred ? 'card.unstar' : 'card.star');
  return (
    <button
      className={`star-toggle${card.starred ? ' on' : ''}`}
      aria-pressed={!!card.starred}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        send({ type: 'updateCard', id: card.id, patch: { starred: !card.starred } });
      }}
    >
      {card.starred ? '★' : '☆'}
    </button>
  );
}
