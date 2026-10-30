import { describe, expect, it } from 'vitest';
import { applyDocEdit, figuresFileFor, figuresTemplate } from '../../src/extension/canvasController';
import { canvasLiterals, canvasMode, compileCanvas, encodeLiteral, figureLines } from '../../src/runner/canvas';
import { computeDAGLayout } from '../../src/webview/canvas/dag';

describe('compileCanvas (CV-1, CV-2)', () => {
  it('turns TSX into CommonJS that requires cursor/canvas', () => {
    const r = compileCanvas('import { Stack, Text } from "cursor/canvas";\nconst n: number = 1;\nexport default function A() { return <Stack><Text>{n}</Text></Stack>; }');
    expect('code' in r && r.code).toContain("require('cursor/canvas')");
    expect('code' in r && r.code).toContain('exports.default');
  });

  it('reports syntax errors with a line number', () => {
    const r = compileCanvas('import { Text } from "cursor/canvas";\nexport default function A() {\n  return <Text>oops</Text>\n  const = 1;\n}');
    expect(r).toMatchObject({ line: 4 });
  });

  it('rejects modules other than cursor/canvas and react', () => {
    // 쓰지 않는 import는 TypeScript 규칙대로 지워지므로, 실제로 쓰는 경우만 막는다.
    const r = compileCanvas('import fs from "fs";\nexport default function A() { return fs.readFileSync("x"); }');
    expect('error' in r && r.error).toContain('fs');
    expect(compileCanvas('import type { ReactNode } from "react";\nexport default function A(): ReactNode { return null; }')).toHaveProperty('code');
  });

  it('compiles the figures template', () => {
    const source = figuresTemplate();
    expect(compileCanvas(source)).toHaveProperty('code');
    expect(canvasMode(source)).toBe('figures');
    expect(figureLines(source)).toEqual({ Example: source.split('\n').findIndex((l) => l.startsWith('export function Example')) + 1 });
  });
});

describe('editing canvas text in the document (TASK-3)', () => {
  const source = [
    'import { Table, Text } from "cursor/canvas";',
    "const rows = [['BE', 'it\\'s'], [\"BE\", `t`]];",
    'export default function A() {',
    '  return <Text title="제목">',
    '    안녕',
    '    세상 {rows.length}',
    '  </Text>;',
    '}',
  ].join('\n');

  it('finds text written in the code, but not imports', () => {
    const literals = canvasLiterals(source);
    expect(literals.map((l) => [l.kind, l.value, l.line])).toEqual([
      ['string', 'BE', 2],
      ['string', "it's", 2],
      ['string', 'BE', 2],
      ['jsxAttr', '제목', 4],
      ['jsxText', '안녕 세상', 4],
    ]);
    expect(canvasMode(source)).toBe('page');
  });

  it('writes edited text back with the original quotes and spacing', () => {
    const [be, its, , attr, text] = canvasLiterals(source);
    const raw = (l: { start: number; end: number }) => source.slice(l.start, l.end);
    expect(encodeLiteral(be!, raw(be!), 'F"E')).toBe("'F\"E'");
    expect(encodeLiteral(its!, raw(its!), "a'b\nc")).toBe("'a\\'b\\nc'");
    expect(encodeLiteral(attr!, raw(attr!), '새 제목')).toBe('"새 제목"');
    expect(encodeLiteral(attr!, raw(attr!), 'say "hi"')).toBe('{"say \\"hi\\""}');
    // `{rows.length}` 앞까지가 한 글자 덩어리다.
    expect(encodeLiteral(text!, raw(text!), '반가워요')).toBe('\n    반가워요 ');
    expect(encodeLiteral(text!, raw(text!), 'a < b')).toBe('\n    {"a < b"} ');

    const edited = source.slice(0, be!.start) + encodeLiteral(be!, raw(be!), 'FE') + source.slice(be!.end);
    expect(compileCanvas(edited)).toHaveProperty('code');
    expect(canvasLiterals(edited)[0]!.value).toBe('FE');
  });

  it('groups text written inside the same brackets', () => {
    const rows = [
      'const ROWS = [',
      '  ["예측 가치 ↑", "pCVR"],',
      '  { name: "팩 후기", reason: "예측 가치 ↑", roas: { prev: "702%" } },',
      '  { name: "앰플", reason: "예측 가치 ↑" },',
      '];',
    ].join('\n');
    const byValue = (v: string) => canvasLiterals(rows).filter((l) => l.value === v);
    const [a, b, c] = byValue('예측 가치 ↑');
    expect(a!.group).toBe(byValue('pCVR')[0]!.group);
    expect(b!.group).toBe(byValue('팩 후기')[0]!.group);
    expect(c!.group).toBe(byValue('앰플')[0]!.group);
    expect(new Set([a!.group, b!.group, c!.group]).size).toBe(3);
    // 안쪽 객체의 글자는 따로 묶인다.
    expect(byValue('702%')[0]!.group).not.toBe(b!.group);
  });

  it('refuses an edit when the file changed in the meantime', () => {
    expect(applyDocEdit('abc', 'abc', 1, 2, 'X')).toBe('aXc');
    expect(applyDocEdit('abcd', 'abc', 1, 2, 'X')).toBeUndefined();
    expect(applyDocEdit('abc', 'abc', 2, 9, 'X')).toBeUndefined();
  });

  it('pairs markdown shared docs with a figures file', () => {
    expect(figuresFileFor('docs/api.md')).toBe('docs/api.canvas.tsx');
  });
});

describe('computeDAGLayout (CV-3)', () => {
  const nodes = ['feature', 'dev', 'prd', 'eks_dev', 'eks_prd'].map((id) => ({ id }));
  const edges = [
    { from: 'feature', to: 'dev' },
    { from: 'dev', to: 'prd' },
    { from: 'dev', to: 'eks_dev' },
    { from: 'prd', to: 'eks_prd' },
  ];

  it('ranks by longest path and centres each rank (vertical)', () => {
    const r = computeDAGLayout({ nodes, edges, nodeWidth: 100, nodeHeight: 40, rankGap: 50, nodeGap: 20, padding: 10 });
    const rank = Object.fromEntries(r.nodes.map((n) => [n.id, n.rank]));
    expect(rank).toEqual({ feature: 0, dev: 1, prd: 2, eks_dev: 2, eks_prd: 3 });
    expect(r.width).toBe(10 * 2 + 100 * 2 + 20);
    expect(r.height).toBe(10 * 2 + 40 * 4 + 50 * 3);
    const dev = r.nodes.find((n) => n.id === 'dev')!;
    expect(dev.x).toBe(10 + (220 - 100) / 2);
    const e = r.edges.find((x) => x.from === 'feature')!;
    expect([e.sourceY, e.targetY]).toEqual([10 + 40, 10 + 90]);
    expect(r.ranks.map((x) => x.nodeIds.length)).toEqual([1, 1, 2, 1]);
  });

  it('flags back edges and still lays out cycles', () => {
    const r = computeDAGLayout({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }] });
    expect(r.edges.map((e) => e.isBackEdge)).toEqual([false, false, true]);
    expect(r.nodes.map((n) => n.rank)).toEqual([0, 1, 2]);
  });

  it('lays out left to right when horizontal', () => {
    const r = computeDAGLayout({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }], direction: 'horizontal', nodeWidth: 80, nodeHeight: 30, rankGap: 40, padding: 0 });
    const [a, b] = r.nodes;
    expect(b!.x - a!.x).toBe(120);
    expect(r.edges[0]).toMatchObject({ sourceX: 80, targetX: 120, sourceY: 15, targetY: 15 });
  });

  it('ignores edges to unknown nodes', () => {
    expect(computeDAGLayout({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'zzz' }] }).edges).toEqual([]);
  });
});

describe('markdown documents (all documents in canvas style)', async () => {
  const { parseMarkdown, documentBlocks, blockEdit, insertParagraphs, checkboxEdit, strikeEdit, splitTag } = await import('../../src/webview/canvas/markdownParse');
  const { sharedDocKind } = await import('../../src/extension/canvasController');
  type Edit = { start: number; end: number; text: string } | undefined;
  const apply = (src: string, e: Edit) => (e ? src.slice(0, e.start) + e.text + src.slice(e.end) : src);

  it('parses headings, lists, task lists, tables, code, quotes and rules with their source lines', () => {
    const md = ['# Title', '', 'Para one', 'continues.', '', '- a', '  - b', '- [x] done', '', '| A | B |', '| :-- | --: |', '| 1 | 2 \\| 3 |', '', '```ts', 'x < 1', '```', '> note', '---'].join('\n');
    expect(parseMarkdown(md).map((b) => [b.kind, b.line, b.end])).toEqual([
      ['heading', 0, 1], ['paragraph', 2, 4], ['list', 5, 8], ['table', 9, 12], ['code', 13, 16], ['quote', 16, 17], ['rule', 17, 18],
    ]);
    const [, para, list, table] = parseMarkdown(md);
    expect(para).toMatchObject({ kind: 'paragraph', text: 'Para one continues.' });
    expect(list).toMatchObject({ items: [{ text: 'a', depth: 0, line: 5, end: 6 }, { text: 'b', depth: 1, line: 6 }, { text: 'done', checked: true, line: 7, end: 8 }] });
    expect(table).toMatchObject({ headers: ['A', 'B'], rows: [['1', '2 | 3']], align: [undefined, 'right'] });
  });

  it('drops the title, empty template sections and demotes headings', () => {
    const md = '# TASK-1 t — Intent\n\n## 목적\n\n## 배경\n\n내용\n\n## 범위\n';
    expect(documentBlocks(md, { skipTitle: true, demote: 1 })).toMatchObject([
      { kind: 'heading', level: 3, text: '배경', line: 4 },
      { kind: 'paragraph', text: '내용', line: 6 },
    ]);
  });

  it('parses figure blocks and collapsible details', () => {
    const md = ['## 흐름', '', '```canvas Flow', '```', '', '<details>', '<summary>POST /api</summary>', '', '### Request', '- a', '</details>', '<details open><summary>열림</summary>', 'x', '</details>'].join('\n');
    expect(parseMarkdown(md)).toMatchObject([
      { kind: 'heading', level: 2, text: '흐름', line: 0 },
      { kind: 'figure', name: 'Flow', line: 2 },
      { kind: 'details', summary: 'POST /api', open: false, line: 5, blocks: [{ kind: 'heading', text: 'Request', line: 8 }, { kind: 'list', line: 9, items: [{ text: 'a', line: 9 }] }] },
      { kind: 'details', summary: '열림', open: true, line: 11, blocks: [{ kind: 'paragraph', text: 'x', line: 12 }] },
    ]);
  });

  it('writes an edited block back to its own lines only, keeping the source format', () => {
    const md = '# T\n\n## [BE] 로그인\n\n옛 문단\n이어짐\n\n- [x] 하나\n- [ ] 둘\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n```\n';
    const blocks = parseMarkdown(md);
    const [, heading, para, list, table, code] = blocks;
    // 제목: 수준과 [태그]를 유지한다. Enter로 이어 쓴 줄은 아래 문단이 된다.
    expect(apply(md, blockEdit(md, heading!, '회원가입'))).toContain('## [BE] 회원가입\n\n옛 문단');
    expect(apply(md, blockEdit(md, heading!, '회원가입\n설명'))).toContain('## [BE] 회원가입\n\n설명\n\n옛 문단');
    // 문단: 줄마다 새 문단. 모두 지우면 문단과 뒤의 빈 줄을 지운다.
    expect(apply(md, blockEdit(md, para!, '새 **문단**\n둘째'))).toContain('## [BE] 로그인\n\n새 **문단**\n\n둘째\n\n- [x] 하나');
    expect(apply(md, blockEdit(md, para!, ''))).toContain('## [BE] 로그인\n\n- [x] 하나');
    // 목록 항목: 기호·체크 상태 유지, 새 줄은 체크 안 된 새 항목
    expect(apply(md, blockEdit(md, list!, '첫째\n추가', { item: 0 }))).toContain('- [x] 첫째\n- [ ] 추가\n- [ ] 둘');
    expect(apply(md, blockEdit(md, list!, '', { item: 1 }))).toContain('- [x] 하나\n\n| A | B |');
    // 표 칸: 그 줄만 다시 쓴다. |는 이스케이프한다.
    expect(apply(md, blockEdit(md, table!, 'x|y', { cell: [0, 1] }))).toContain('| 1 | x\\|y |');
    expect(apply(md, blockEdit(md, table!, '머리', { cell: [-1, 0] }))).toContain('| 머리 | B |\n| --- | --- |');
    // 코드: 펜스 사이만 바꾼다.
    expect(apply(md, blockEdit(md, code!, 'a\nb'))).toContain('```\na\nb\n```\n');
    const c = checkboxEdit(md, 8, true)!;
    expect(apply(md, c)).toContain('- [x] 둘');
    expect(checkboxEdit(md, 4, true)).toBeUndefined();
  });

  it('strikes a list item through and back, keeping its marker and checkbox', () => {
    const md = '- [ ] 하나\n- [x] **둘** \r\n3. 셋\n본문\n';
    expect(apply(md, strikeEdit(md, 0, true))).toBe('- [ ] ~~하나~~\n- [x] **둘** \r\n3. 셋\n본문\n');
    expect(apply(md, strikeEdit(md, 1, true))).toBe('- [ ] 하나\n- [x] ~~**둘**~~ \r\n3. 셋\n본문\n');
    expect(apply(md, strikeEdit(md, 2, true))).toContain('3. ~~셋~~\n');
    const struck = '- [ ] ~~하나~~\n';
    expect(apply(struck, strikeEdit(struck, 0, false))).toBe('- [ ] 하나\n');
    expect(apply(struck, strikeEdit(struck, 0, true))).toBe(struck);
    expect(strikeEdit(md, 3, true)).toBeUndefined();
    expect(strikeEdit('- [ ] \n', 0, true)).toBeUndefined();
  });

  it('adds text under an empty section or to an empty document', () => {
    const md = '# T\n\n## 목적\n\n## 배경\n';
    expect(apply(md, insertParagraphs(md, 2, '새 목적'))).toBe('# T\n\n## 목적\n\n새 목적\n\n## 배경\n');
    expect(apply('# T\n', insertParagraphs('# T\n', undefined, '본문'))).toBe('# T\n\n본문\n');
    expect(apply('', insertParagraphs('', undefined, '본문'))).toBe('본문\n');
    expect(insertParagraphs(md, 2, '  ')).toBeUndefined();
  });

  it('keeps CRLF line endings', () => {
    const md = '# T\r\n\r\n문단\r\n';
    expect(apply(md, blockEdit(md, parseMarkdown(md)[1]!, '바뀜\n둘'))).toBe('# T\r\n\r\n바뀜\r\n\r\n둘\r\n');
  });

  it('splits plan tags from headings', () => {
    expect(splitTag('[BE] 로그인 API')).toEqual({ tags: ['BE'], title: '로그인 API' });
    expect(splitTag('[BE][ML] 지역 매핑')).toEqual({ tags: ['BE', 'ML'], title: '지역 매핑' });
    expect(splitTag('그냥 제목')).toEqual({ tags: [], title: '그냥 제목' });
  });

  it('opens canvas and markdown shared docs in the board', () => {
    expect(sharedDocKind('docs/api.canvas.tsx')).toBe('canvas');
    expect(sharedDocKind('docs/ERD.md')).toBe('markdown');
    expect(sharedDocKind('docs/erd.png')).toBeUndefined();
  });
});
