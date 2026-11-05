import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalState, approvalText } from '../../src/core/approval';
import { BoardRepository } from '../../src/storage/repository';

describe('approvalState', () => {
  it('is approved only while the documents match what was approved', () => {
    expect(approvalState(undefined, 'a')).toBe('none');
    expect(approvalState({ at: 't', hash: 'a' }, 'a')).toBe('approved');
    expect(approvalState({ at: 't', hash: 'a' }, 'b')).toBe('changed');
    expect(approvalState({ at: 't', hash: 'a' }, undefined)).toBe('changed');
  });

  it('treats CRLF and LF as the same text and keeps documents apart', () => {
    expect(approvalText(['a\r\nb', undefined])).toBe(approvalText(['a\nb', '']));
    expect(approvalText(['ab', ''])).not.toBe(approvalText(['a', 'b']));
  });
});

describe('BoardRepository.docsHash', () => {
  let root: string | undefined;
  afterEach(async () => root && fs.rm(root, { recursive: true, force: true }));

  it('changes when intent.md or spec.md changes but not when plan.md changes', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-board-approval-'));
    const repo = new BoardRepository(root, 'ko');
    await repo.init();
    const card = await repo.createCard({ title: '승인' }, 1);
    const first = await repo.docsHash(card.id);
    expect((await repo.loadCard(card.id)).docsHash).toBe(first);
    await repo.writeTaskDoc(card.id, 'plan', '- [ ] 다른 문서\n');
    expect(await repo.docsHash(card.id)).toBe(first);
    await repo.writeTaskDoc(card.id, 'spec', '## 요구사항\n- 에이전트가 바꿈\n');
    expect(await repo.docsHash(card.id)).not.toBe(first);
  });
});
