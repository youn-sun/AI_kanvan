// AI 규칙: 보드의 규칙 문서 하나를 도구마다 읽는 파일(CLAUDE.md·AGENTS.md·.cursor/rules)로 만든다.
// 만든 파일은 다른 저장소에 따로 올라갈 수 있으므로 원본 경로를 가져오지 않고 본문을 그대로 넣는다.

import type { ToolId } from './types';

/** 보드가 만든 파일 첫 줄에 넣는 표시. 이 표시가 없는 파일은 덮어쓰지 않는다. */
export const GENERATED_MARK = 'agent-board:generated';
/** Codex는 AGENTS.md를 32KiB까지만 읽는다. 넘치는 규칙은 링크로 넘긴다. */
export const CODEX_INLINE_BUDGET = 24 * 1024;

export interface RuleSource {
  id: string;
  name: string;
  /** 레포 루트 기준 원본 경로 */
  path: string;
  tools: ToolId[];
  /** 적용 폴더. 빈 문자열이면 레포 전체 */
  scope: string;
  body: string;
  /** 내 PC에만: 팀 파일 대신 개인용 파일로 넘기고 git이 무시하게 한다 */
  local?: boolean;
}

export interface PlannedFile {
  /** 레포 루트 기준 경로 */
  path: string;
  tool: ToolId;
  scope: string;
  ruleIds: string[];
  content: string;
  /** 개인용 파일. 그 폴더의 git 저장소에서 무시하게 한다 */
  local?: boolean;
}

type Locale = 'ko' | 'en';

const TEXT = {
  ko: {
    header: '보드의 "AI 규칙"에서 고치세요. 이 파일을 직접 고치면 보드가 확인을 받아요.',
    more: '## 더 읽을 규칙',
    read: '작업 전에 읽고 따른다.',
  },
  en: {
    header: 'Edit this in the board\'s "AI rules". The board asks before overwriting manual edits.',
    more: '## More rules',
    read: 'read and follow before working.',
  },
};

export function isGenerated(text: string): boolean {
  return text.slice(0, 400).includes(GENERATED_MARK);
}

export function normalizeScope(scope: string): string {
  return scope.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

function join(scope: string, file: string): string {
  return scope ? `${scope}/${file}` : file;
}

/** from 폴더에서 to 파일로 가는 상대 경로 */
export function relativePath(fromDir: string, to: string): string {
  const from = fromDir ? fromDir.split('/') : [];
  const parts = to.split('/');
  let i = 0;
  while (i < from.length && i < parts.length - 1 && from[i] === parts[i]) i += 1;
  return [...from.slice(i).map(() => '..'), ...parts.slice(i)].join('/');
}

function slug(rule: RuleSource): string {
  const base = rule.path.split('/').at(-1)!.replace(/\.(md|markdown|mdc)$/i, '');
  return base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || rule.id;
}

function header(locale: Locale): string {
  return `<!-- ${GENERATED_MARK} — ${TEXT[locale].header} -->`;
}

/** `## 제목` 바로 다음 줄에 두는 절별 도구 표시. 없으면 규칙의 모든 도구에 넣는다. */
const SECTION_TOOLS = /^\s*<!--\s*agent-board:tools\s*([a-z,\s]*?)\s*-->\s*$/;
const SECTION_HEADING = /^##(?!#)\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

export interface RuleSection {
  /** 첫 `##` 앞 글이면 빈 문자열. 이 부분은 늘 모든 도구에 넣는다 */
  title: string;
  /** 제목 줄 (0부터). 범위는 [line, end) */
  line: number;
  end: number;
  /** 절에 표시한 도구. 없으면 규칙의 도구를 따른다 */
  tools?: ToolId[];
}

function lines(body: string): string[] {
  return body.replace(/\r\n/g, '\n').split('\n');
}

function parseTools(text: string): ToolId[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ToolId => s === 'claude' || s === 'codex' || s === 'cursor');
}

export function ruleSections(body: string): RuleSection[] {
  const all = lines(body);
  const out: RuleSection[] = [];
  let current: RuleSection = { title: '', line: 0, end: all.length };
  let fence = false;
  all.forEach((line, i) => {
    if (FENCE.test(line)) fence = !fence;
    const m = !fence && SECTION_HEADING.exec(line);
    if (!m) return;
    out.push({ ...current, end: i });
    const mark = SECTION_TOOLS.exec(all[i + 1] ?? '');
    current = { title: m[1]!.trim(), line: i, end: all.length, tools: mark ? parseTools(mark[1]!) : undefined };
  });
  out.push(current);
  return out.filter((s) => s.title || all.slice(s.line, s.end).some((l) => l.trim()));
}

/** 절에 실제로 넣는 도구 */
export function sectionTools(section: RuleSection, ruleTools: ToolId[]): ToolId[] {
  return section.title && section.tools ? ruleTools.filter((t) => section.tools!.includes(t)) : ruleTools;
}

/** 그 도구에 넣을 절만 남긴 본문. 절 표시 줄은 뺀다. */
export function bodyFor(body: string, tool: ToolId, ruleTools: ToolId[], only?: (s: RuleSection) => boolean): string {
  const all = lines(body);
  return ruleSections(body)
    .filter((s) => sectionTools(s, ruleTools).includes(tool) && (!only || only(s)))
    .map((s) => all.slice(s.line, s.end).filter((l) => !SECTION_TOOLS.test(l)).join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 절의 도구 표시를 바꾼다. tools가 없으면 표시를 지워 규칙의 도구를 따르게 한다. */
export function setSectionTools(body: string, headingLine: number, tools: ToolId[] | undefined): string {
  const all = lines(body);
  if (!SECTION_HEADING.test(all[headingLine] ?? '')) throw new Error('section heading moved');
  const mark = tools && `<!-- agent-board:tools ${tools.join(',')} -->`;
  const has = SECTION_TOOLS.test(all[headingLine + 1] ?? '');
  if (has && mark) all[headingLine + 1] = mark;
  else if (has) all.splice(headingLine + 1, 1);
  else if (mark) all.splice(headingLine + 1, 0, mark);
  return all.join('\n');
}

/** 규칙 목록으로 도구별 파일 내용을 정한다. 순서는 규칙 목록 순서다. */
export function planRuleFiles(rules: RuleSource[], locale: Locale = 'ko'): PlannedFile[] {
  const out: PlannedFile[] = [];
  const scopes = [...new Set(rules.map((r) => normalizeScope(r.scope)))];
  for (const scope of scopes) {
    const inScope = rules.filter((r) => normalizeScope(r.scope) === scope);
    const uses = (tool: ToolId, local: boolean) => inScope.filter((r) => r.tools.includes(tool) && !!r.local === local);
    // Claude는 CLAUDE.md 옆의 CLAUDE.local.md를 개인용으로 함께 읽는다.
    for (const local of [false, true]) {
      const claude = uses('claude', local);
      if (!claude.length) continue;
      out.push({
        path: join(scope, local ? 'CLAUDE.local.md' : 'CLAUDE.md'),
        tool: 'claude',
        scope,
        ruleIds: claude.map((r) => r.id),
        content: [header(locale), ...claude.map((r) => bodyFor(r.body, 'claude', r.tools))].join('\n\n') + '\n',
        ...(local && { local }),
      });
    }
    const inlined = new Set<string>();
    const shared = uses('codex', false);
    if (shared.length) out.push(codexFile(shared, scope, 'AGENTS.md', locale, inlined));
    // Codex는 AGENTS.override.md가 있으면 그 폴더의 AGENTS.md 대신 읽으므로 팀 규칙도 함께 넣는다.
    const mine = uses('codex', true);
    if (mine.length) out.push({ ...codexFile([...shared, ...mine], scope, 'AGENTS.override.md', locale), local: true });
    // Cursor는 AGENTS.md도 읽으므로, 거기 본문이 들어간 규칙은 Cursor에만 가는 절만 따로 만든다.
    for (const r of inScope.filter((x) => x.tools.includes('cursor'))) {
      const text = inlined.has(r.id)
        ? bodyFor(r.body, 'cursor', r.tools, (s) => !!s.title && !sectionTools(s, r.tools).includes('codex'))
        : bodyFor(r.body, 'cursor', r.tools);
      if (!text) continue;
      out.push({
        path: join(scope, `.cursor/rules/${slug(r)}.mdc`),
        tool: 'cursor',
        scope,
        ruleIds: [r.id],
        content: `---\ndescription: ${r.name.replace(/\n/g, ' ')}\nalwaysApply: true\n---\n${header(locale)}\n\n${text}\n`,
        ...(r.local && { local: true }),
      });
    }
  }
  return out;
}

function codexFile(codex: RuleSource[], scope: string, name: string, locale: Locale, inlined = new Set<string>()): PlannedFile {
  let used = 0;
  const parts: string[] = [];
  const links: string[] = [];
  for (const r of codex) {
    const text = bodyFor(r.body, 'codex', r.tools);
    const size = new TextEncoder().encode(text).length;
    if (used + size <= CODEX_INLINE_BUDGET) {
      used += size;
      inlined.add(r.id);
      parts.push(text);
    } else {
      links.push(`- [${r.name}](${relativePath(scope, r.path)}): ${TEXT[locale].read}`);
    }
  }
  if (links.length) parts.push([TEXT[locale].more, '', ...links].join('\n'));
  return { path: join(scope, name), tool: 'codex', scope, ruleIds: codex.map((r) => r.id), content: [header(locale), ...parts].join('\n\n') + '\n' };
}

/** CLAUDE.md의 `@경로` 가져오기 줄과 나머지 글 */
export function splitClaudeImports(text: string): { imports: string[]; rest: string } {
  const imports: string[] = [];
  const rest = text
    .split(/\r?\n/)
    .filter((line) => {
      const m = /^@(\S+)\s*$/.exec(line.trim());
      if (m) imports.push(m[1]!);
      return !m;
    })
    .join('\n')
    .trim();
  return { imports, rest };
}

export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/** 본문 첫 제목. 파일 이름뿐인 제목(`# CLAUDE.md`)은 쓰지 않는다. */
export function ruleTitle(body: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(body);
  const title = m?.[1]?.trim();
  if (!title || /^(CLAUDE|AGENTS)\.md\b/i.test(title)) return fallback;
  return title;
}

/** 두 규칙 본문이 거의 같은지. 줄 집합이 90% 넘게 겹치면 같다고 본다. */
export function nearlySame(a: string, b: string): boolean {
  const lines = (t: string) => new Set(t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const x = lines(a);
  const y = lines(b);
  if (x.size === 0 || y.size === 0) return false;
  let common = 0;
  for (const l of x) if (y.has(l)) common += 1;
  return common / Math.max(x.size, y.size) >= 0.9;
}
