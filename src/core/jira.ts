// 카드 → Jira 티켓 발급. 초안 만들기·형식 검사·Jira 문서(ADF) 변환은 여기서 결정론적으로 한다.
// 티켓 형식: 제목 `[서비스] 할 일`, 설명은 배경·목적 / 할 일 / 완료 기준(체크리스트) / 참고·확인 사항(있을 때만).
// 필드 ID는 코드에 두지 않고 Jira 생성 메타데이터(createmeta)의 필수 선택 필드를 그대로 쓴다.

/** board.json에 두는 팀 공유 설정 */
export interface JiraSettings {
  /** 예: example.atlassian.net */
  site: string;
  projectKey: string;
}

/** 업무 유형에 꼭 골라야 하는 단일 선택 필드 (예: 업무 구분) */
export interface JiraField {
  id: string;
  name: string;
  options: { id: string; name: string }[];
}

export interface JiraIssueType {
  id: string;
  name: string;
  fields: JiraField[];
}

export interface JiraIssueRef {
  key: string;
  summary: string;
  status?: string;
}

export interface TicketDraft {
  typeId: string;
  /** 필드 ID → 선택값 ID */
  fieldValues: Record<string, string>;
  service: string;
  title: string;
  background: string;
  todo: string;
  /** 한 줄에 하나 */
  criteria: string;
  notes: string;
  /** 마케터 리뷰가 필요한 작업이면 승인 조건을 완료 기준에 넣는다 */
  review: boolean;
  /** 배포가 필요한 작업이면 배포 조건을 완료 기준에 넣는다 */
  deploy: boolean;
}

export const SECTION = { background: '배경·목적', todo: '할 일', criteria: '완료 기준', notes: '참고·확인 사항' } as const;
export const REVIEW_LINE = '마케터가 결과를 확인하고 승인했다.';
export const DEPLOY_AFTER_REVIEW_LINE = '승인된 변경 사항을 배포했다.';
export const DEPLOY_LINE = '변경 사항을 배포했다.';

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

export function normalizeSite(site: string): string {
  return site
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

export function issueUrl(settings: JiraSettings, key: string): string {
  return `https://${normalizeSite(settings.site)}/browse/${key}`;
}

// ---- 카드 문서 → 초안 ----

/** `## 제목` 단위로 본문을 나눈다. 코드 블록 안의 `#`은 제목으로 보지 않는다. */
export function sections(markdown: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | undefined;
  let body: string[] = [];
  let fence = false;
  const flush = () => heading !== undefined && out.set(heading, cleanBody(body.join('\n')));
  for (const line of (markdown ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{2,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      heading = h[1]!.trim();
      body = [];
    } else body.push(line);
  }
  flush();
  return out;
}

function cleanBody(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pick(map: Map<string, string>, names: string[]): string {
  return names
    .map((n) => map.get(n))
    .filter((v): v is string => !!v)
    .join('\n\n');
}

/** 목록이 있으면 목록 항목만, 없으면 문단마다 한 줄로 만든다. 체크박스 표시는 뺀다. */
export function toLines(text: string): string[] {
  const items = text.split('\n').flatMap((l) => {
    const m = LIST_ITEM.exec(l);
    return m && m[1]!.trim() ? [m[1]!.trim()] : [];
  });
  if (items.length) return items;
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

/**
 * 카드 제목과 작업 문서로 초안을 채운다.
 * intent.md 목적·배경 → 배경·목적, spec.md 요구사항(없으면 intent.md 범위) → 할 일, spec.md 완료 조건 → 완료 기준.
 * 카드 제목이 `[서비스] …`면 서비스로 쓴다.
 */
export function draftFromDocs(cardTitle: string, intent: string | undefined, spec: string | undefined): Pick<TicketDraft, 'service' | 'title' | 'background' | 'todo' | 'criteria'> {
  const i = sections(intent);
  const s = sections(spec);
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(cardTitle.trim());
  return {
    service: m ? m[1]!.trim() : '',
    title: m ? m[2]!.trim() : cardTitle.trim(),
    background: pick(i, ['목적', '배경', 'Purpose', 'Background']),
    todo: pick(s, ['요구사항', 'Requirements']) || pick(i, ['범위', 'Scope']),
    criteria: toLines(pick(s, ['완료 조건', 'Acceptance criteria'])).join('\n'),
  };
}

// ---- 티켓 내용 ----

export function ticketSummary(d: Pick<TicketDraft, 'service' | 'title'>): string {
  return `[${d.service.trim()}] ${d.title.trim()}`;
}

/** 사용자가 쓴 완료 기준 뒤에 리뷰·배포 조건을 붙인다. 이미 같은 줄이 있으면 다시 넣지 않는다. */
export function criteriaLines(d: Pick<TicketDraft, 'criteria' | 'review' | 'deploy'>): string[] {
  // 화면에서는 한 줄에 하나씩 쓴다. 목록 기호나 체크박스를 붙여 써도 뗀다.
  const lines = d.criteria
    .split(/\r?\n/)
    .map((l) => (LIST_ITEM.exec(l)?.[1] ?? l).trim())
    .filter(Boolean);
  const extra = [d.review && REVIEW_LINE, d.deploy && (d.review ? DEPLOY_AFTER_REVIEW_LINE : DEPLOY_LINE)].filter((x): x is string => !!x);
  return [...lines, ...extra.filter((x) => !lines.includes(x))];
}

/** 미리보기와 Jira 설명이 같은 내용이 되도록 Markdown으로도 만든다. */
export function ticketMarkdown(d: TicketDraft): string {
  const parts = [
    `### ${SECTION.background}\n\n${d.background.trim()}`,
    `### ${SECTION.todo}\n\n${d.todo.trim()}`,
    `### ${SECTION.criteria}\n\n${criteriaLines(d)
      .map((l) => `- [ ] ${l}`)
      .join('\n')}`,
  ];
  if (d.notes.trim()) parts.push(`### ${SECTION.notes}\n\n${d.notes.trim()}`);
  return `${parts.join('\n\n')}\n`;
}

// ---- 형식 검사 ----

export type LintCode =
  | 'type'
  | 'field'
  | 'service'
  | 'serviceBracket'
  | 'title'
  | 'background'
  | 'todo'
  | 'criteria'
  | 'secret'
  | 'vague'
  | 'placeholder'
  | 'bugResult';

export interface LintIssue {
  code: LintCode;
  /** error는 등록을 막고, warn은 알리기만 한다 */
  level: 'error' | 'warn';
  /** field: 비어 있는 필드 이름 */
  field?: string;
}

const SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ATATT[A-Za-z0-9_=-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const VAGUE = /개발 완료|정상\s*동작|정상적으로 동작/;
const PLACEHOLDER = /미정|\bTBD\b/;

export function isBugType(type: Pick<JiraIssueType, 'name'> | undefined): boolean {
  return !!type && /버그|bug/i.test(type.name);
}

export function lintTicket(d: TicketDraft, types: JiraIssueType[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const error = (code: LintCode, field?: string) => issues.push({ code, level: 'error', ...(field ? { field } : {}) });
  const warn = (code: LintCode) => issues.push({ code, level: 'warn' });
  const type = types.find((t) => t.id === d.typeId);
  if (!type) error('type');
  for (const f of type?.fields ?? []) if (!f.options.some((o) => o.id === d.fieldValues[f.id])) error('field', f.name);
  if (!d.service.trim()) error('service');
  else if (/[[\]]/.test(d.service)) error('serviceBracket');
  if (!d.title.trim()) error('title');
  if (!d.background.trim()) error('background');
  if (!d.todo.trim()) error('todo');
  const criteria = criteriaLines(d);
  if (criteria.length === 0) error('criteria');
  const all = [d.service, d.title, d.background, d.todo, d.notes, ...criteria].join('\n');
  if (SECRET.test(all)) error('secret');
  if (criteria.some((l) => VAGUE.test(l))) warn('vague');
  if (PLACEHOLDER.test(all)) warn('placeholder');
  if (isBugType(type) && !(/기대/.test(d.background) && /실제/.test(d.background))) warn('bugResult');
  return issues;
}

export function blocking(issues: LintIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}

// ---- Jira 문서(ADF) ----

type Mark = { type: 'strong' } | { type: 'code' } | { type: 'link'; attrs: { href: string } };
type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hardBreak' };
type Node = Record<string, unknown>;

/** `**굵게**`, `` `코드` ``, `[글](주소)`만 서식으로 바꾸고 나머지는 글자 그대로 둔다. */
export function inlineNodes(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (s: string) => s && out.push({ type: 'text', text: s });
  while ((m = re.exec(text))) {
    plain(text.slice(last, m.index));
    if (m[1] !== undefined) out.push({ type: 'text', text: m[1], marks: [{ type: 'code' }] });
    else if (m[2] !== undefined) out.push({ type: 'text', text: m[2], marks: [{ type: 'strong' }] });
    else out.push({ type: 'text', text: m[3]!, marks: [{ type: 'link', attrs: { href: m[4]! } }] });
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return out;
}

/** 본문을 문단과 목록으로 바꾼다. 문단 안의 줄바꿈은 그대로 줄바꿈으로 둔다. */
export function blockNodes(text: string): Node[] {
  const nodes: Node[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.trim()) {
      i += 1;
      continue;
    }
    const first = /^\s*([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(lines[i]!);
    if (first) {
      const ordered = /\d/.test(first[1]!);
      const items: Node[] = [];
      let m: RegExpExecArray | null;
      while (i < lines.length && (m = /^\s*([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(lines[i]!)) && /\d/.test(m[1]!) === ordered) {
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineNodes(m[2]!.trim()) }] });
        i += 1;
      }
      nodes.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) para.push(lines[i++]!.trim());
    const content: Inline[] = [];
    para.forEach((p, n) => {
      if (n) content.push({ type: 'hardBreak' });
      content.push(...inlineNodes(p));
    });
    nodes.push({ type: 'paragraph', content });
  }
  return nodes;
}

const heading = (text: string): Node => ({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text }] });

/**
 * 설명을 ADF로 만든다. 완료 기준은 Jira 체크리스트(taskList)로 넣는다.
 * tasks가 false면 체크리스트를 지원하지 않는 Jira를 위해 `[ ] ` 글머리 목록으로 넣는다.
 */
export function ticketAdf(d: TicketDraft, newId: () => string, tasks = true): Node {
  const criteria = criteriaLines(d);
  const criteriaNode: Node = tasks
    ? {
        type: 'taskList',
        attrs: { localId: newId() },
        content: criteria.map((l) => ({ type: 'taskItem', attrs: { localId: newId(), state: 'TODO' }, content: inlineNodes(l) })),
      }
    : {
        type: 'bulletList',
        content: criteria.map((l) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inlineNodes(`[ ] ${l}`) }] })),
      };
  const content: Node[] = [
    heading(SECTION.background),
    ...blockNodes(d.background),
    heading(SECTION.todo),
    ...blockNodes(d.todo),
    heading(SECTION.criteria),
    criteriaNode,
  ];
  if (d.notes.trim()) content.push(heading(SECTION.notes), ...blockNodes(d.notes));
  return { type: 'doc', version: 1, content };
}

/** 이슈 생성 요청 본문. 담당자는 Jira 자동화가 정하므로 넣지 않는다. */
export function issuePayload(d: TicketDraft, settings: JiraSettings, types: JiraIssueType[], newId: () => string, tasks = true): Node {
  const type = types.find((t) => t.id === d.typeId);
  const fields: Node = {
    project: { key: settings.projectKey.trim() },
    issuetype: { id: d.typeId },
    summary: ticketSummary(d),
    description: ticketAdf(d, newId, tasks),
  };
  // 유형에 있는 필드만 보낸다. 버그·기타에 작업의 업무 구분을 보내지 않는다.
  for (const f of type?.fields ?? []) if (d.fieldValues[f.id]) fields[f.id] = { id: d.fieldValues[f.id] };
  return { fields };
}

// ---- Jira 응답 읽기 ----

/** GET /rest/api/3/issue/createmeta/{project}/issuetypes. 하위 작업은 카드에서 만들지 않으므로 뺀다. */
export function parseIssueTypes(json: unknown): { id: string; name: string }[] {
  const list = ((json as { issueTypes?: unknown[]; values?: unknown[] }).issueTypes ?? (json as { values?: unknown[] }).values ?? []) as {
    id?: string;
    name?: string;
    subtask?: boolean;
  }[];
  return list.filter((t) => t.id && t.name && !t.subtask).map((t) => ({ id: t.id!, name: t.name! }));
}

/** GET /rest/api/3/issue/createmeta/{project}/issuetypes/{id}. 꼭 골라야 하는 단일 선택 사용자 필드만 남긴다. */
export function parseTypeFields(json: unknown): JiraField[] {
  const list = ((json as { fields?: unknown[]; values?: unknown[] }).fields ?? (json as { values?: unknown[] }).values ?? []) as {
    fieldId?: string;
    key?: string;
    name?: string;
    required?: boolean;
    schema?: { type?: string; custom?: string };
    allowedValues?: { id?: string; value?: string; name?: string }[];
  }[];
  return list
    .filter((f) => f.required && f.schema?.type === 'option' && (f.fieldId ?? f.key ?? '').startsWith('customfield_'))
    .map((f) => ({
      id: (f.fieldId ?? f.key)!,
      name: f.name ?? (f.fieldId ?? f.key)!,
      options: (f.allowedValues ?? []).filter((o) => o.id).map((o) => ({ id: o.id!, name: o.value ?? o.name ?? o.id! })),
    }));
}

/** GET /rest/api/3/search/jql (fields=summary,status) */
export function parseIssues(json: unknown): JiraIssueRef[] {
  const list = ((json as { issues?: unknown[] }).issues ?? []) as { key?: string; fields?: { summary?: string; status?: { name?: string } } }[];
  return list
    .filter((i) => i.key && typeof i.fields?.summary === 'string')
    .map((i) => ({ key: i.key!, summary: i.fields!.summary!, ...(i.fields?.status?.name ? { status: i.fields.status.name } : {}) }));
}

/** 최근 티켓 제목에서 쓰인 서비스 표기를 많이 쓴 순서로 모은다. */
export function servicesOf(issues: JiraIssueRef[]): string[] {
  const count = new Map<string, number>();
  for (const i of issues) {
    const m = /^\[([^\]]+)\]/.exec(i.summary.trim());
    if (m) count.set(m[1]!.trim(), (count.get(m[1]!.trim()) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/^\[[^\]]*\]/, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2),
  );
}

/**
 * 같은 서비스의 비슷한 티켓. 초안 제목 단어의 절반 이상이 겹치면 후보로 보여 준다.
 * 판단은 사람이 한다. 같은 일이면 새로 만들지 않고 그 티켓에 연결한다.
 */
export function similarIssues(d: Pick<TicketDraft, 'service' | 'title'>, issues: JiraIssueRef[], limit = 3): JiraIssueRef[] {
  const mine = words(d.title);
  if (mine.size === 0) return [];
  const service = d.service.trim().toLowerCase();
  return issues
    .filter((i) => (/^\[([^\]]+)\]/.exec(i.summary)?.[1]?.trim().toLowerCase() ?? '') === service)
    .map((i) => {
      const theirs = words(i.summary);
      const shared = [...mine].filter((w) => theirs.has(w)).length;
      return { i, score: shared / mine.size };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.i);
}
