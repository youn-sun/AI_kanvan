import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bodyFor,
  CODEX_INLINE_BUDGET,
  isGenerated,
  planRuleFiles,
  relativePath,
  ruleSections,
  setSectionTools,
  type RuleSource,
} from '../../src/core/agentRules';
import { defaultBoard, type BoardConfig } from '../../src/core/types';
import { RulesSync } from '../../src/storage/rulesSync';

const rule = (over: Partial<RuleSource>): RuleSource => ({
  id: 'doc-1',
  name: 'Rule',
  path: '.agent-board/rules/rule.md',
  tools: ['claude', 'codex', 'cursor'],
  scope: '',
  body: '# Rule\n\n- do this',
  ...over,
});

describe('rule sections', () => {
  const body = ['# Rule', 'intro', '', '## Shared', '- both', '', '## Claude', '<!-- agent-board:tools claude -->', '- claude only', '', '```', '## not a heading', '```'].join('\n');

  it('splits at ## headings outside code and reads the tools mark', () => {
    expect(ruleSections(body).map((s) => [s.title, s.line, s.tools])).toEqual([
      ['', 0, undefined],
      ['Shared', 3, undefined],
      ['Claude', 6, ['claude']],
    ]);
  });

  it('sends each tool only its sections and drops the mark', () => {
    const files = planRuleFiles([rule({ body })]);
    const claude = files.find((f) => f.path === 'CLAUDE.md')!.content;
    const agents = files.find((f) => f.path === 'AGENTS.md')!.content;
    expect(claude).toContain('- claude only');
    expect(claude).not.toContain('agent-board:tools');
    expect(agents).toContain('- both');
    expect(agents).not.toContain('- claude only');
  });

  it('gives Cursor only its own sections when AGENTS.md already has the rest', () => {
    const cursorBody = body.replace('tools claude', 'tools cursor').replace('claude only', 'cursor only');
    const mdc = planRuleFiles([rule({ body: cursorBody })]).find((f) => f.tool === 'cursor')!.content;
    expect(mdc).toContain('- cursor only');
    expect(mdc).not.toContain('- both');
  });

  it('adds, changes and removes the tools mark', () => {
    const marked = setSectionTools(body, 3, ['codex']);
    expect(ruleSections(marked)[1]!.tools).toEqual(['codex']);
    expect(bodyFor(marked, 'claude', ['claude', 'codex'])).not.toContain('- both');
    expect(setSectionTools(marked, 3, undefined)).toBe(body);
    expect(() => setSectionTools(body, 4, ['codex'])).toThrow();
  });
});

describe('planRuleFiles', () => {
  it('writes this-PC-only rules to personal files, with team rules copied into the Codex override', () => {
    const files = planRuleFiles([rule({}), rule({ id: 'doc-2', name: 'Mine', body: '# Mine\n\n- only me', local: true })]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['CLAUDE.md']!.content).not.toContain('- only me');
    expect(byPath['CLAUDE.local.md']).toMatchObject({ local: true });
    expect(byPath['AGENTS.override.md']!.content).toContain('- do this');
    expect(byPath['AGENTS.override.md']!.content).toContain('- only me');
    expect(files.filter((f) => f.tool === 'cursor').map((f) => f.local)).toEqual([true]);
  });

  it('writes the full text for Claude and Codex and skips Cursor when AGENTS.md already has it', () => {
    const files = planRuleFiles([rule({})]);
    expect(files.map((f) => f.path)).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(files.every((f) => isGenerated(f.content) && f.content.includes('- do this'))).toBe(true);
  });

  it('links long rules in AGENTS.md and gives Cursor its own rule file', () => {
    const long = rule({ id: 'doc-2', name: 'Long', path: 'CONVENTIONS.md', body: `# Long\n${'x'.repeat(CODEX_INLINE_BUDGET)}` });
    const files = planRuleFiles([rule({ scope: 'backend' }), { ...long, scope: 'backend' }]);
    const agents = files.find((f) => f.path === 'backend/AGENTS.md')!;
    expect(agents.content).toContain('- do this');
    expect(agents.content).toContain('[Long](../CONVENTIONS.md)');
    expect(files.map((f) => f.path)).toContain('backend/.cursor/rules/CONVENTIONS.mdc');
  });

  it('makes relative paths between folders', () => {
    expect(relativePath('', 'a/b.md')).toBe('a/b.md');
    expect(relativePath('backend', '.agent-board/rules/x.md')).toBe('../.agent-board/rules/x.md');
    expect(relativePath('a/b', 'a/c.md')).toBe('../c.md');
  });
});

describe('RulesSync', () => {
  let root: string;
  let sync: RulesSync;
  const write = (rel: string, text: string) => fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }).then(() => fs.writeFile(path.join(root, rel), text));
  const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
  const exists = (rel: string) => fs.access(path.join(root, rel)).then(() => true, () => false);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-'));
    sync = new RulesSync(root, path.join(root, '.agent-board/local'));
    await write('AGENTS.md', '# 공통 개발 규칙\n\n- 컨벤션을 따른다\n');
    await write('CLAUDE.md', '@AGENTS.md\n@.claude/commit-style.md\n');
    await write('.claude/commit-style.md', '# 커밋 규칙\n\n- AI 표기 금지\n');
    await write('backend/CLAUDE.md', '# CLAUDE.md\n\n백엔드 구조\n');
    const body = Array.from({ length: 20 }, (_, i) => `- line ${i}`).join('\n');
    await write('nol/AGENTS.md', `# AGENTS.md\n\nguidance to Codex\n${body}\n`);
    await write('nol/CLAUDE.md', `# CLAUDE.md\n\nguidance to Claude\n${body}\n`);
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  async function imported(): Promise<BoardConfig> {
    const result = await sync.importFiles(defaultBoard());
    await sync.sync(result.board, new Set(result.replaced));
    await sync.removeMoved(result.moved);
    return result.board;
  }

  it('moves a rule to this PC only: team file back to the original, personal file ignored by git', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', path.join(root, 'backend'), '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    git('init', '-q');
    git('add', 'CLAUDE.md');
    git('commit', '-qm', 'team rules');
    await write('backend/.git/info/exclude', '# git ls-files --others --exclude-from=.git/info/exclude\n');
    let board = await imported();
    const backend = board.sharedDocs.find((d) => d.rule?.scope === 'backend')!;
    board = { ...board, sharedDocs: board.sharedDocs.map((d) => (d === backend ? { ...d, rule: { ...d.rule!, local: true } } : d)) };
    const state = await sync.sync(board);

    expect(await read('backend/CLAUDE.md')).toBe('# CLAUDE.md\n\n백엔드 구조\n');
    expect(await read('backend/CLAUDE.local.md')).toContain('백엔드 구조');
    expect(state.files.find((f) => f.path === 'backend/CLAUDE.local.md')?.local).toBe(true);
    expect(await read('backend/.git/info/exclude')).toContain('# agent-board: local AI rules\n/CLAUDE.local.md\n# agent-board: end\n');
    expect(state.importable).not.toContain('backend/CLAUDE.md');

    board = { ...board, sharedDocs: board.sharedDocs.map((d) => (d.id === backend.id ? { ...d, rule: { ...d.rule!, local: undefined } } : d)) };
    await sync.sync(board);
    expect(await exists('backend/CLAUDE.local.md')).toBe(false);
    expect(await read('backend/.git/info/exclude')).toBe('# git ls-files --others --exclude-from=.git/info/exclude\n');
  });

  it('finds rule files the board did not make', async () => {
    expect(await sync.findImportable()).toEqual(['AGENTS.md', 'CLAUDE.md', 'backend/CLAUDE.md', 'nol/AGENTS.md', 'nol/CLAUDE.md']);
  });

  it('imports existing files, keeps what each tool read, and writes them back as generated files', async () => {
    const board = await imported();
    const rules = board.sharedDocs.map((d) => ({ name: d.name, tools: d.rule!.tools, scope: d.rule!.scope }));
    expect(rules).toEqual([
      { name: '공통 개발 규칙', tools: ['codex', 'cursor', 'claude'], scope: '' },
      { name: 'nol 규칙 (Codex)', tools: ['codex', 'cursor'], scope: 'nol' },
      { name: '커밋 규칙', tools: ['claude'], scope: '' },
      { name: 'backend 규칙 (Claude)', tools: ['claude'], scope: 'backend' },
      { name: 'nol 규칙 (Claude)', tools: ['claude'], scope: 'nol' },
    ]);
    const claude = await read('CLAUDE.md');
    expect(isGenerated(claude)).toBe(true);
    expect(claude).toContain('- 컨벤션을 따른다');
    expect(claude).toContain('- AI 표기 금지');
    expect(await read('backend/CLAUDE.md')).toContain('백엔드 구조');
    expect(await exists('.claude/commit-style.md')).toBe(false);
    expect(await exists('backend/AGENTS.md')).toBe(false);
    expect(await sync.findImportable()).toEqual([]);
    const state = await sync.sync(board);
    expect(state.files.every((f) => f.state === 'ok')).toBe(true);
    expect(state.duplicates).toEqual([[board.sharedDocs[1]!.id, board.sharedDocs[4]!.id]]);
  });

  it('follows rule edits, but does not overwrite generated files someone edited by hand', async () => {
    const board = await imported();
    const doc = board.sharedDocs.find((d) => d.rule!.scope === 'backend')!;
    await write(doc.path, '# 백엔드\n\n새 구조\n');
    await sync.sync(board);
    expect(await read('backend/CLAUDE.md')).toContain('새 구조');

    await write('backend/CLAUDE.md', `${await read('backend/CLAUDE.md')}손으로 고침\n`);
    await write(doc.path, '# 백엔드\n\n또 바뀜\n');
    const state = await sync.sync(board);
    expect(state.files.find((f) => f.path === 'backend/CLAUDE.md')?.state).toBe('edited');
    expect(await read('backend/CLAUDE.md')).toContain('손으로 고침');
    await sync.sync(board, new Set(['backend/CLAUDE.md']));
    expect(await read('backend/CLAUDE.md')).toContain('또 바뀜');
  });

  it('removes generated files when the rule stops sending to that tool', async () => {
    const board = await imported();
    const next = {
      ...board,
      sharedDocs: board.sharedDocs.map((d) => (d.rule!.scope === 'backend' ? { ...d, rule: { ...d.rule!, tools: ['codex' as const] } } : d)),
    };
    await sync.sync(next);
    expect(await exists('backend/CLAUDE.md')).toBe(false);
    expect(await read('backend/AGENTS.md')).toContain('백엔드 구조');
  });
});
