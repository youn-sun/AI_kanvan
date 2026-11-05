import { describe, expect, it } from 'vitest';
import {
  criteriaLines,
  draftFromDocs,
  issuePayload,
  lintTicket,
  parseIssues,
  parseIssueTypes,
  parseTypeFields,
  servicesOf,
  similarIssues,
  ticketAdf,
  ticketMarkdown,
  ticketSummary,
  type JiraIssueType,
  type TicketDraft,
} from '../../src/core/jira';
import { taskDocTemplate } from '../../src/storage/templates';

const TASK: JiraIssueType = { id: '11323', name: '작업', fields: [{ id: 'customfield_10485', name: '업무 구분', options: [{ id: '10340', name: '기능 개발' }, { id: '10341', name: '기능 추가' }] }] };
const BUG: JiraIssueType = { id: '11324', name: '버그', fields: [] };
const TYPES = [TASK, BUG];

const draft = (over: Partial<TicketDraft> = {}): TicketDraft => ({
  typeId: '11323',
  fieldValues: { customfield_10485: '10341' },
  service: 'SA 대시보드',
  title: '조회 결과 CSV 다운로드 추가',
  background: '마케터가 조회 결과를 내려받아 보고서 작성에 활용할 수 있게 한다.',
  todo: '현재 조회 조건에 해당하는 결과를 CSV 파일로 내려받을 수 있게 한다.',
  criteria: '내려받은 파일의 데이터가 조회 조건과 일치한다.',
  notes: '',
  review: true,
  deploy: true,
  ...over,
});

describe('draftFromDocs', () => {
  it('fills the three sections from intent.md and spec.md', () => {
    const intent = [
      '# TASK-1 CSV — Intent',
      '',
      '## 목적',
      '마케터가 조회 결과를 내려받게 한다.',
      '',
      '## 배경',
      '<!-- 템플릿 안내 -->',
      '지금은 화면을 캡처해 보고서를 만든다.',
      '',
      '## 범위',
      '조회 화면만',
    ].join('\n');
    const spec = ['## 요구사항', '- CSV 다운로드 버튼', '- 조회 조건 유지', '', '## 완료 조건', '- [ ] 파일 내용이 조회 조건과 같다', '- [x] 한글이 깨지지 않는다', '```', '## 코드 안 제목', '```'].join('\n');
    expect(draftFromDocs('[SA 대시보드] CSV 다운로드', intent, spec)).toEqual({
      service: 'SA 대시보드',
      title: 'CSV 다운로드',
      background: '마케터가 조회 결과를 내려받게 한다.\n\n지금은 화면을 캡처해 보고서를 만든다.',
      todo: '- CSV 다운로드 버튼\n- 조회 조건 유지',
      criteria: '파일 내용이 조회 조건과 같다\n한글이 깨지지 않는다',
    });
  });

  it('uses the intent scope when spec has no requirements and leaves empty template sections empty', () => {
    const d = draftFromDocs('CSV 다운로드', taskDocTemplate('intent', 'TASK-1', 'CSV') + '\n## 범위\n조회 화면만\n', taskDocTemplate('spec', 'TASK-1', 'CSV'));
    expect(d).toMatchObject({ service: '', title: 'CSV 다운로드', background: '', todo: '조회 화면만', criteria: '' });
  });
});

describe('ticket content', () => {
  it('builds the summary and appends review and deploy conditions once', () => {
    expect(ticketSummary(draft())).toBe('[SA 대시보드] 조회 결과 CSV 다운로드 추가');
    expect(criteriaLines(draft())).toEqual(['내려받은 파일의 데이터가 조회 조건과 일치한다.', '마케터가 결과를 확인하고 승인했다.', '승인된 변경 사항을 배포했다.']);
    expect(criteriaLines(draft({ review: false }))).toEqual(['내려받은 파일의 데이터가 조회 조건과 일치한다.', '변경 사항을 배포했다.']);
    expect(criteriaLines(draft({ criteria: '- [ ] 마케터가 결과를 확인하고 승인했다.', deploy: false }))).toEqual(['마케터가 결과를 확인하고 승인했다.']);
    expect(criteriaLines(draft({ criteria: '첫째 조건\n\n- [x] 둘째 조건\n', review: false, deploy: false }))).toEqual(['첫째 조건', '둘째 조건']);
  });

  it('writes the kit format', () => {
    expect(ticketMarkdown(draft({ notes: '- [Dev](https://dev.example.com)' }))).toBe(
      [
        '### 배경·목적',
        '',
        '마케터가 조회 결과를 내려받아 보고서 작성에 활용할 수 있게 한다.',
        '',
        '### 할 일',
        '',
        '현재 조회 조건에 해당하는 결과를 CSV 파일로 내려받을 수 있게 한다.',
        '',
        '### 완료 기준',
        '',
        '- [ ] 내려받은 파일의 데이터가 조회 조건과 일치한다.',
        '- [ ] 마케터가 결과를 확인하고 승인했다.',
        '- [ ] 승인된 변경 사항을 배포했다.',
        '',
        '### 참고·확인 사항',
        '',
        '- [Dev](https://dev.example.com)',
        '',
      ].join('\n'),
    );
  });
});

describe('lintTicket', () => {
  it('passes a complete task', () => {
    expect(lintTicket(draft(), TYPES)).toEqual([]);
  });

  it('blocks missing type, required field, service, sections and criteria', () => {
    const codes = (d: TicketDraft) => lintTicket(d, TYPES).map((i) => `${i.level}:${i.code}${i.field ? `:${i.field}` : ''}`);
    expect(codes(draft({ fieldValues: {} }))).toEqual(['error:field:업무 구분']);
    expect(codes(draft({ fieldValues: { customfield_10485: '999' } }))).toEqual(['error:field:업무 구분']);
    expect(codes(draft({ typeId: '' }))).toEqual(['error:type']);
    expect(codes(draft({ service: ' ', title: '', background: '', todo: '\n', criteria: '', review: false, deploy: false }))).toEqual([
      'error:service',
      'error:title',
      'error:background',
      'error:todo',
      'error:criteria',
    ]);
    expect(codes(draft({ service: '[SA]' }))).toEqual(['error:serviceBracket']);
    expect(codes(draft({ notes: 'token ghp_abcdefghijklmnopqrstuvwxyz123456' }))).toEqual(['error:secret']);
  });

  it('warns about vague criteria, placeholders and bugs without expected and actual results', () => {
    const codes = (d: TicketDraft) => lintTicket(d, TYPES).map((i) => `${i.level}:${i.code}`);
    expect(codes(draft({ criteria: '개발 완료' }))).toEqual(['warn:vague']);
    expect(codes(draft({ notes: '일정 미정' }))).toEqual(['warn:placeholder']);
    expect(codes(draft({ typeId: '11324', fieldValues: {} }))).toEqual(['warn:bugResult']);
    expect(codes(draft({ typeId: '11324', background: '기대 결과는 다운로드, 실제 결과는 아무 일도 없음' }))).toEqual([]);
  });
});

describe('Jira payload', () => {
  const ids = () => {
    let n = 0;
    return () => `id-${n++}`;
  };

  it('sends the project, type, summary, ADF description and only the fields of that type', () => {
    const payload = issuePayload(draft(), { site: 'x.atlassian.net', projectKey: 'FDE' }, TYPES, ids()) as { fields: Record<string, unknown> };
    expect(payload.fields).toMatchObject({
      project: { key: 'FDE' },
      issuetype: { id: '11323' },
      summary: '[SA 대시보드] 조회 결과 CSV 다운로드 추가',
      customfield_10485: { id: '10341' },
    });
    expect(payload.fields).not.toHaveProperty('assignee');
    const bug = issuePayload(draft({ typeId: '11324' }), { site: 'x', projectKey: 'FDE' }, TYPES, ids()) as { fields: Record<string, unknown> };
    expect(bug.fields).not.toHaveProperty('customfield_10485');
  });

  it('turns sections into headings, paragraphs, lists and a task list', () => {
    const adf = ticketAdf(draft({ todo: '첫 줄 `code`\n둘째 줄\n\n- **굵게**\n- [링크](https://a.b/c)', review: false, deploy: false }), ids()) as { content: unknown[] };
    expect(adf.content).toEqual([
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '배경·목적' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '마케터가 조회 결과를 내려받아 보고서 작성에 활용할 수 있게 한다.' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '할 일' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '첫 줄 ' }, { type: 'text', text: 'code', marks: [{ type: 'code' }] }, { type: 'hardBreak' }, { type: 'text', text: '둘째 줄' }],
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '굵게', marks: [{ type: 'strong' }] }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '링크', marks: [{ type: 'link', attrs: { href: 'https://a.b/c' } }] }] }] },
        ],
      },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '완료 기준' }] },
      {
        type: 'taskList',
        attrs: { localId: 'id-0' },
        content: [{ type: 'taskItem', attrs: { localId: 'id-1', state: 'TODO' }, content: [{ type: 'text', text: '내려받은 파일의 데이터가 조회 조건과 일치한다.' }] }],
      },
    ]);
    const plain = ticketAdf(draft({ review: false, deploy: false }), ids(), false) as { content: { type: string }[] };
    expect(plain.content.at(-1)).toEqual({
      type: 'bulletList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[ ] 내려받은 파일의 데이터가 조회 조건과 일치한다.' }] }] }],
    });
  });
});

describe('reading Jira responses', () => {
  it('keeps issue types except sub-tasks and only required single-select custom fields', () => {
    expect(
      parseIssueTypes({ issueTypes: [{ id: '11323', name: '작업', subtask: false }, { id: '11322', name: '하위 작업', subtask: true }] }),
    ).toEqual([{ id: '11323', name: '작업' }]);
    expect(
      parseTypeFields({
        fields: [
          { fieldId: 'summary', name: '요약', required: true, schema: { type: 'string' } },
          { fieldId: 'customfield_10485', name: '업무 구분', required: true, schema: { type: 'option' }, allowedValues: [{ id: '10340', value: '기능 개발' }] },
          { fieldId: 'customfield_1', name: '선택', required: false, schema: { type: 'option' }, allowedValues: [] },
        ],
      }),
    ).toEqual([{ id: 'customfield_10485', name: '업무 구분', options: [{ id: '10340', name: '기능 개발' }] }]);
  });

  it('collects services from recent summaries and finds similar tickets of the same service', () => {
    const recent = parseIssues({
      issues: [
        { key: 'FDE-3', fields: { summary: '[SA 대시보드] 조회 결과 CSV 다운로드', status: { name: '진행 중' } } },
        { key: 'FDE-2', fields: { summary: '[AutoX] 캠페인 대시보드 개발' } },
        { key: 'FDE-1', fields: { summary: '[SA 대시보드] 입찰 규칙 수정' } },
        { key: 'BAD' },
      ],
    });
    expect(recent.map((i) => i.key)).toEqual(['FDE-3', 'FDE-2', 'FDE-1']);
    expect(servicesOf(recent)).toEqual(['SA 대시보드', 'AutoX']);
    expect(similarIssues(draft(), recent).map((i) => i.key)).toEqual(['FDE-3']);
    expect(similarIssues(draft({ service: 'AutoX' }), recent)).toEqual([]);
  });
});
