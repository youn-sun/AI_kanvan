import { describe, expect, it } from 'vitest';
import type { Card } from '../../src/core/types';
import { matchesFilter } from '../../src/webview/cards';

const view = (starred?: boolean) => ({ card: { id: 'TASK-1', status: 'todo', starred } as Card }) as Parameters<typeof matchesFilter>[0];

describe('starred cards', () => {
  it('shows only starred cards when the starred filter is on', () => {
    expect(matchesFilter(view(true), { starred: true }, [])).toBe(true);
    expect(matchesFilter(view(), { starred: true }, [])).toBe(false);
    expect(matchesFilter(view(), {}, [])).toBe(true);
  });
});
