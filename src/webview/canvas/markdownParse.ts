// Markdown 파싱 (TASK-3). 그리기는 markdown.tsx가 한다.
// 블록마다 원문 줄 번호(0부터)를 남겨, 문서 화면에서 절·체크박스를 원문에 바로 고칠 수 있게 한다.

import { HEADING_TAG, headingTags, unstruck } from '../../core/checklist';

export interface ListItem {
  text: string;
  depth: number;
  checked?: boolean;
  line: number;
  /** 다음 항목 전까지, 뒤쪽 빈 줄 제외 */
  end: number;
}

/** line·end: 원문 줄 범위 [line, end). 뒤쪽 빈 줄은 포함하지 않는다. */
export type Block = { line: number; end: number } & (
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'table'; headers: string[]; rows: string[][]; align: ('left' | 'center' | 'right' | undefined)[] }
  | { kind: 'code'; text: string }
  /** ```canvas 이름``` — 같은 이름의 canvas 그림 컴포넌트를 이 자리에 그린다 */
  | { kind: 'figure'; name: string }
  /** <details><summary>…</summary> … </details> — 접는 절 */
  | { kind: 'details'; summary: string; open: boolean; blocks: Block[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
);

export const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const FIGURE = /^canvas\s+([A-Za-z_$][\w$]*)\s*$/;
const DETAILS_OPEN = /^\s*<details(\s+open)?\s*>/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;
const SUMMARY = /<summary>(.*?)<\/summary>/i;
const PARAGRAPH_END = /^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*\||\s*<\/?details)/i;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  return parseLines(lines, 0, lines.length);
}

/** lines[from, to)를 블록으로 나눈다. 줄 번호는 전체 문서 기준이다. */
function parseLines(lines: string[], from: number, to: number): Block[] {
  const blocks: Block[] = [];
  let i = from;
  while (i < to) {
    const line = lines[i]!;
    const start = i;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = /^\s*(```|~~~)\s*(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < to && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i += 1;
      const figure = FIGURE.exec(fence[2]!.trim());
      blocks.push(figure ? { kind: 'figure', name: figure[1]!, line: start, end: 0 } : { kind: 'code', text: body.join('\n'), line: start, end: 0 });
      continue;
    }
    const details = DETAILS_OPEN.exec(line);
    if (details) {
      // 짝이 맞는 </details>까지. 안쪽의 <details>도 센다.
      let depth = 1;
      let end = i + 1;
      while (end < to) {
        if (DETAILS_OPEN.test(lines[end]!)) depth += 1;
        else if (DETAILS_CLOSE.test(lines[end]!) && --depth === 0) break;
        end += 1;
      }
      let bodyFrom = i;
      let summary = SUMMARY.exec(line)?.[1];
      if (summary === undefined && i + 1 < end && SUMMARY.test(lines[i + 1]!)) {
        summary = SUMMARY.exec(lines[i + 1]!)![1];
        bodyFrom = i + 1;
      }
      blocks.push({
        kind: 'details',
        summary: (summary ?? '').trim(),
        open: !!details[1],
        blocks: parseLines(lines, bodyFrom + 1, end),
        line: start,
        end: 0,
      });
      i = end + 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim(), line: start, end: 0 });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule', line: start, end: 0 });
      i += 1;
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < to && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const headers = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < to && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      blocks.push({ kind: 'table', headers, rows, align, line: start, end: 0 });
      continue;
    }
    if (line.trim().startsWith('>')) {
      const body: string[] = [];
      while (i < to && lines[i]!.trim().startsWith('>')) body.push(lines[i++]!.trim().replace(/^>\s?/, ''));
      blocks.push({ kind: 'quote', text: body.join('\n'), line: start, end: 0 });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const items: ListItem[] = [];
      while (i < to) {
        const m = LIST_ITEM.exec(lines[i]!);
        if (m) {
          items.push({
            depth: Math.floor(m[1]!.replace(/\t/g, '    ').length / 2),
            text: m[4]!.trim(),
            checked: m[3] === undefined ? undefined : m[3] !== ' ',
            line: i,
            end: 0,
          });
          i += 1;
        } else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
          // 목록 항목이 다음 줄로 이어지는 경우
          items[items.length - 1]!.text += ` ${lines[i]!.trim()}`;
          i += 1;
        } else break;
      }
      blocks.push({ kind: 'list', ordered, items, line: start, end: 0 });
      continue;
    }
    const para: string[] = [];
    while (i < to && lines[i]!.trim() && !PARAGRAPH_END.test(lines[i]!) && !LIST_ITEM.exec(lines[i]!)) para.push(lines[i++]!.trim());
    if (para.length === 0) {
      // 짝이 없는 </details> 같은 줄
      i += 1;
      continue;
    }
    blocks.push({ kind: 'paragraph', text: para.join(' '), line: start, end: 0 });
  }
  // 끝 줄: 다음 블록 전까지에서 뒤쪽 빈 줄을 뺀다.
  const trim = (from: number, upto: number) => {
    let e = upto;
    while (e > from + 1 && !lines[e - 1]!.trim()) e -= 1;
    return e;
  };
  blocks.forEach((b, k) => {
    b.end = trim(b.line, blocks[k + 1]?.line ?? to);
    if (b.kind === 'list') b.items.forEach((item, n) => (item.end = trim(item.line, b.items[n + 1]?.line ?? b.end)));
  });
  return blocks;
}

/** 제목 맨 앞의 [태그]들을 떼어 낸다 (plan.md 구분 태그). */
export function splitTag(text: string): { tags: string[]; title: string } {
  const m = HEADING_TAG.exec(text);
  return m ? { tags: headingTags(text), title: text.slice(m[0].length).trim() } : { tags: [], title: text };
}

/** 내용 없이 제목만 남은 절(템플릿 그대로인 절)을 뺀다. */
export function pruneEmptySections(blocks: Block[]): Block[] {
  return blocks.filter((b, i) => {
    if (b.kind !== 'heading') return true;
    for (let j = i + 1; j < blocks.length; j += 1) {
      const next = blocks[j]!;
      if (next.kind !== 'heading') return true;
      if (next.level <= b.level) return false;
    }
    return false;
  });
}

export interface DocumentOptions {
  /** 맨 앞의 H1(문서 제목)을 뺀다. 카드 문서처럼 제목을 따로 보여 줄 때 쓴다. */
  skipTitle?: boolean;
  /** 제목 수준을 이만큼 낮춘다. */
  demote?: number;
}

export function documentBlocks(source: string, { skipTitle, demote = 0 }: DocumentOptions = {}): Block[] {
  let blocks = parseMarkdown(source);
  if (skipTitle && blocks[0]?.kind === 'heading' && blocks[0].level === 1) blocks = blocks.slice(1);
  return pruneEmptySections(blocks).map((b) => (b.kind === 'heading' ? { ...b, level: Math.min(6, b.level + demote) } : b));
}

/** 원문의 줄 시작 위치. CRLF 문서에서도 원문 기준 위치를 돌려준다. */
export function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') offsets.push(i + 1);
  return offsets;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** 원문 줄 [a, b)를 lines로 바꾸는 편집. lines가 비면 그 줄들과 뒤따르는 빈 줄 하나를 지운다. */
export function replaceLines(source: string, a: number, b: number, lines: string[], dropBlank = true): TextEdit {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const offsets = lineOffsets(source);
  const start = offsets[a] ?? source.length;
  let end = offsets[b] ?? source.length;
  if (lines.length === 0) {
    const next = offsets[b + 1];
    if (dropBlank && next !== undefined && !source.slice(end, next).trim()) end = next;
    return { start, end, text: '' };
  }
  return { start, end, text: lines.join(eol) + (offsets[b] !== undefined ? eol : '') };
}

/** 사용자가 고친 글을 문단으로 나눈다. 줄마다 한 문단이고 문단 사이에 빈 줄을 둔다. */
export function paragraphLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l, i) => (i ? ['', l] : [l]));
}

const sourceLine = (source: string, line: number) => source.replace(/\r\n/g, '\n').split('\n')[line] ?? '';
const rawCells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** 블록 안의 어느 부분을 고쳤는지: 목록 항목 번호, 표 칸([행, 열], 머리글은 행 -1) */
export interface BlockPart {
  item?: number;
  cell?: [number, number];
}

/** 화면에서 고친 블록을 원문 편집으로 바꾼다. 원문 형식(제목 수준·태그·목록 기호·체크박스)은 유지한다. */
export function blockEdit(source: string, block: Block, text: string, part: BlockPart = {}): TextEdit | undefined {
  const parts = text.split('\n').map((l) => l.trim()).filter(Boolean);
  switch (block.kind) {
    case 'paragraph':
      return replaceLines(source, block.line, block.end, paragraphLines(text));
    case 'heading': {
      const m = /^(\s*#{1,6}\s+)((?:\[[^\]]+\]\s*)*)/.exec(sourceLine(source, block.line));
      if (!m || parts.length === 0) return replaceLines(source, block.line, block.line + 1, []);
      const rest = paragraphLines(parts.slice(1).join('\n'));
      return replaceLines(source, block.line, block.line + 1, [m[1]! + (m[2] ?? '') + parts[0]!, ...(rest.length ? ['', ...rest] : [])]);
    }
    case 'list': {
      const item = block.items[part.item ?? -1];
      if (!item) return undefined;
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s+)?/.exec(sourceLine(source, item.line));
      if (!m) return undefined;
      // 새로 생긴 항목은 같은 기호로, 체크박스면 체크 안 된 상태로 만든다.
      const lines = parts.map((p, i) => m[1]! + (m[2] ? (i ? '[ ] ' : m[2]) : '') + p);
      // 항목을 지울 때는 목록 뒤의 빈 줄을 남긴다.
      return replaceLines(source, item.line, item.end, lines, false);
    }
    case 'table': {
      const [row, col] = part.cell ?? [-2, -1];
      const line = row < 0 ? block.line : block.line + 2 + row;
      const cells = rawCells(sourceLine(source, line));
      if (col < 0 || col >= Math.max(cells.length, block.headers.length)) return undefined;
      cells[col] = parts.join(' ').replace(/(?<!\\)\|/g, '\\|');
      return replaceLines(source, line, line + 1, [`| ${cells.join(' | ')} |`]);
    }
    case 'quote':
      return replaceLines(source, block.line, block.end, text.trim() ? text.split('\n').map((l) => (l.trim() ? `> ${l.trim()}` : '>')) : []);
    case 'code':
      // 펜스 줄 사이의 본문만 바꾼다.
      return replaceLines(source, block.line + 1, Math.max(block.line + 1, block.end - 1), text.replace(/\s+$/, '').split('\n'), false);
    default:
      return undefined;
  }
}

/** 빈 절의 제목 아래(line 다음), 또는 line이 없으면 문서 끝에 문단을 넣는다. */
export function insertParagraphs(source: string, afterLine: number | undefined, text: string): TextEdit | undefined {
  const lines = paragraphLines(text);
  if (lines.length === 0) return undefined;
  if (afterLine !== undefined) return replaceLines(source, afterLine + 1, afterLine + 1, ['', ...lines]);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lead = !source ? '' : source.endsWith(eol + eol) ? '' : source.endsWith(eol) ? eol : eol + eol;
  return { start: source.length, end: source.length, text: lead + lines.join(eol) + eol };
}

/** 체크박스 항목의 `[ ]`·`[x]`를 바꾸는 편집. 그 줄이 더 이상 체크박스가 아니면 undefined. */
export function checkboxEdit(source: string, line: number, checked: boolean): TextEdit | undefined {
  const offsets = lineOffsets(source);
  const start = offsets[line];
  if (start === undefined) return undefined;
  const text = source.slice(start, offsets[line + 1] ?? source.length);
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(text);
  if (!m) return undefined;
  const at = start + m[1]!.length + 1;
  return { start: at, end: at + 1, text: checked ? 'x' : ' ' };
}

/** 목록 항목 글 전체에 취소선(`~~글~~`)을 긋거나 푼다. 목록 기호·체크박스는 그대로 둔다. */
export function strikeEdit(source: string, line: number, struck: boolean): TextEdit | undefined {
  const offsets = lineOffsets(source);
  const start = offsets[line];
  if (start === undefined) return undefined;
  const text = source.slice(start, offsets[line + 1] ?? source.length).replace(/\r?\n$/, '');
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)(.*?)\s*$/.exec(text);
  if (!m || !m[2]) return undefined;
  const body = unstruck(m[2]);
  const at = start + m[1]!.length;
  return { start: at, end: at + m[2].length, text: struck ? `~~${body}~~` : body };
}
