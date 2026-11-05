// 카드 승인. 사용자가 확인한 작업 문서 내용에 승인을 묶는다.
// 승인한 뒤 문서가 바뀌면(에이전트가 고친 경우 포함) 승인이 풀린 것으로 본다.

import type { TaskDoc } from './types';

/** 승인 대상 문서. Jira 티켓 초안이 이 문서로 채워진다 */
export const APPROVAL_DOCS: readonly TaskDoc[] = ['intent', 'spec'];

export interface CardApproval {
  /** 승인한 시각 (ISO) */
  at: string;
  /** 승인할 때의 APPROVAL_DOCS 내용 해시 */
  hash: string;
}

/** none: 승인 안 함, approved: 지금 문서가 승인한 내용과 같음, changed: 승인한 뒤 문서가 바뀜 */
export type ApprovalState = 'none' | 'approved' | 'changed';

export function approvalState(approval: CardApproval | undefined, docsHash: string | undefined): ApprovalState {
  if (!approval) return 'none';
  return docsHash !== undefined && approval.hash === docsHash ? 'approved' : 'changed';
}

/** 해시할 내용. 줄바꿈 문자 차이(CRLF)는 같은 내용으로 본다. 없는 문서는 빈 문서로 본다 */
export function approvalText(docs: (string | undefined)[]): string {
  return docs.map((d) => (d ?? '').replace(/\r\n/g, '\n')).join('\u0000');
}
