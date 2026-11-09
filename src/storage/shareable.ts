// S-2: Git으로 공유하는 파일에 기기 의존 값이 들어가지 않게 막는다.
// 절대 경로 검사는 경로가 들어가는 필드에만 한다. 제목·설명 같은 자유 입력은 검사하지 않는다.

import type { BoardConfig, Card } from '../core/types';

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\|~[\\/])/;
const FORBIDDEN_KEYS = new Set(['sessionId', 'toolSessionId', 'pid', 'hostname', 'token', 'apiKey']);

export class NotShareableError extends Error {
  constructor(readonly where: string) {
    super(`machine-specific value is not allowed in shared file: ${where}`);
  }
}

function assertNoForbiddenKeys(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenKeys(v, `${where}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) throw new NotShareableError(`${where}.${k}`);
      assertNoForbiddenKeys(v, `${where}.${k}`);
    }
  }
}

function assertNoAbsolutePaths(value: unknown, where: string): void {
  if (typeof value === 'string') {
    if (ABSOLUTE_PATH.test(value)) throw new NotShareableError(where);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoAbsolutePaths(v, `${where}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoAbsolutePaths(v, `${where}.${k}`);
  }
}

export function assertShareableCard(card: Card): void {
  assertNoForbiddenKeys(card, '$');
  assertNoAbsolutePaths(card.workspace, '$.workspace');
  assertNoAbsolutePaths(card.agents, '$.agents');
}

export function assertShareableBoard(board: BoardConfig): void {
  assertNoForbiddenKeys(board, '$');
  board.sharedDocs.forEach((d, i) => {
    assertNoAbsolutePaths(d.path, `$.sharedDocs[${i}].path`);
    if (d.rule) assertNoAbsolutePaths(d.rule.scope, `$.sharedDocs[${i}].rule.scope`);
  });
}
