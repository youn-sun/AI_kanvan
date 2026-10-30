// 문서 화면에서 바로 고치기 (TASK-3). 워드처럼 글을 눌러 그 자리에서 고친다.
// - md 글: 문단·제목·목록 항목·표 칸·인용·코드를 바로 고친다. 고친 블록의 원문 줄만 바뀐다.
//   Enter는 새 문단(목록이면 새 항목), 내용을 모두 지우면 그 블록을 지운다. 체크박스는 누르면 바로 반영한다.
// - 그림·canvas 코드: 글자를 두 번 누르면 코드에 직접 쓴 문자열을 그 자리에서 고친다. 코드로 만든 글자는 코드나 에이전트로 보낸다.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { CanvasLiteral, CanvasPayload, DocTarget, ToExtension } from '../shared/protocol';
import { unstruck } from '../core/checklist';
import { useHostTheme } from './canvas/host';
import { FigureBlock } from './canvas/markdown';
import {
  blockEdit,
  checkboxEdit,
  insertParagraphs,
  strikeEdit,
  parseMarkdown,
  splitTag,
  type Block,
  type BlockPart,
  type DocumentOptions,
  type TextEdit,
} from './canvas/markdownParse';
import { canvasTypography } from './canvas/theme';
import { Callout, CollapsibleSection, Divider, Pill, Stack, Table, inlineMarkdown } from './canvas/ui';
import { onMessage, send, useT } from './vscode';

/** 그사이 파일이 바뀌어 저장하지 못했을 때 알린다. */
function useConflict(dir: string): [boolean, () => void] {
  const [conflict, setConflict] = useState(false);
  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type === 'docTextConflict' && msg.dir === dir) setConflict(true);
      }),
    [dir],
  );
  return [conflict, useCallback(() => setConflict(false), [])];
}

export function ConflictBanner({ dir }: { dir: string }) {
  const t = useT();
  const [conflict, dismiss] = useConflict(dir);
  if (!conflict) return null;
  return (
    <div className="doc-conflict" role="alert">
      <span>{t('edit.conflict')}</span>
      <button onClick={dismiss}>{t('edit.dismiss')}</button>
    </div>
  );
}

/** 화면의 글을 Markdown으로 되돌린다. 굵게·코드·링크·취소선과 줄바꿈을 지킨다. */
function serialize(node: Node, plain: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.replace(/\u00a0/g, ' ');
  if (!(node instanceof HTMLElement)) return '';
  const inner = () => [...node.childNodes].map((c) => serialize(c, plain)).join('');
  const tag = node.tagName;
  if (tag === 'BR') return '\n';
  if (tag === 'DIV' || tag === 'P') return `\n${inner()}`;
  if (plain) return inner();
  if (tag === 'STRONG' || tag === 'B') return `**${inner()}**`;
  if (tag === 'EM' || tag === 'I') return `*${inner()}*`;
  if (tag === 'CODE') return `\`${inner()}\``;
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return `~~${inner()}~~`;
  if (tag === 'A') return `[${inner()}](${node.getAttribute('href') ?? ''})`;
  return inner();
}

/**
 * 바로 고칠 수 있는 글. 포커스를 잃으면 저장한다. Esc는 되돌린다.
 * 저장한 뒤 원문(revision)이 바뀌면 이 글을 새로 그린다. 이어 쓴 줄은 새 블록으로 따로 그려지므로 여기서 지운다.
 */
function Editable({
  md,
  revision,
  onCommit,
  as: Tag = 'div',
  multiline = true,
  plain,
  placeholder,
  style,
}: {
  md: string;
  revision?: string;
  onCommit: (text: string) => void;
  as?: 'div' | 'span' | 'p' | 'code';
  multiline?: boolean;
  plain?: boolean;
  placeholder?: string;
  style?: CSSProperties;
}) {
  const [version, setVersion] = useState(0);
  const cancelled = useRef(false);
  const committed = useRef(false);
  useEffect(() => {
    if (!committed.current) return;
    committed.current = false;
    setVersion((v) => v + 1);
  }, [revision]);
  return (
    <Tag
      key={`${version}:${md}`}
      className="md-editable"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder={placeholder}
      style={style}
      onBlur={(e) => {
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        const next = serialize(e.currentTarget, !!plain).replace(/^\n/, '').replace(/\s+$/, '');
        if (next === md.replace(/\s+$/, '')) return;
        committed.current = true;
        onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelled.current = true;
          setVersion((v) => v + 1);
        } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (multiline) document.execCommand('insertLineBreak');
          else e.currentTarget.blur();
        } else if (!plain && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
          // 고르던 글에 취소선을 긋는다.
          e.preventDefault();
          document.execCommand('strikeThrough');
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
      }}
      onClickCapture={(e) => {
        // 고치는 중에는 링크를 Cmd·Ctrl+클릭으로만 연다.
        if ((e.target as Element).closest('a') && !(e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {md ? (plain ? md : inlineMarkdown(md, 'e')) : null}
    </Tag>
  );
}

/** 체크박스 아이콘. canvas의 TodoList와 같은 모양이다. */
function CheckIcon({ checked }: { checked: boolean }) {
  const t = useHostTheme();
  const color = checked ? t.category.green : t.text.tertiary;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="1.4" />
      {checked && <path d="m5.3 8.2 1.8 1.8 3.6-3.8" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** 취소선 기호: 가로줄이 지나가는 S */
function StrikeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <path d="M10.8 4.6c-.5-.9-1.5-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2.1 0 .9.5 1.5 1.6 1.9M5.2 11.4c.5.9 1.6 1.4 2.9 1.4 1.7 0 2.9-.9 2.9-2.2 0-.4-.1-.8-.3-1.1" />
      <path d="M2.8 8h10.4" />
    </svg>
  );
}

interface BlockContext {
  source: string;
  apply: (edit: TextEdit | undefined) => void;
  placeholder: string;
  checkLabel: string;
  strikeLabel: string;
}

function BlockView({ block, ctx, emptyAfter }: { block: Block; ctx: BlockContext; emptyAfter?: boolean }) {
  const t = useHostTheme();
  const body: CSSProperties = { margin: 0, color: t.text.primary, ...canvasTypography.body };
  const edit = (text: string, part?: BlockPart) => ctx.apply(blockEdit(ctx.source, block, text, part));

  switch (block.kind) {
    case 'heading': {
      const { tags, title } = splitTag(block.text);
      const level = Math.min(3, Math.max(1, block.level)) as 1 | 2 | 3;
      const H = `h${level}` as const;
      return (
        <>
          <H style={{ margin: block.level <= 1 ? 0 : '12px 0 0', color: t.text.primary, ...canvasTypography[`h${level}`], display: 'flex', alignItems: 'center', gap: 8 }}>
            {tags.map((tag) => (
              <Pill key={tag} size="sm">
                {tag}
              </Pill>
            ))}
            <Editable as="span" md={title} revision={ctx.source} onCommit={edit} style={{ flex: 1, minWidth: 0 }} />
          </H>
          {emptyAfter && (
            <Editable as="p" md="" revision={ctx.source} placeholder={ctx.placeholder} style={body} onCommit={(text) => ctx.apply(insertParagraphs(ctx.source, block.line, text))} />
          )}
        </>
      );
    }
    case 'paragraph':
      return <Editable as="p" md={block.text} revision={ctx.source} onCommit={edit} style={body} />;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      const tasks = block.items.every((x) => x.checked !== undefined);
      const itemKeys = uniqueKeys(block.items, (x) => x.text);
      return (
        <Tag className={tasks ? 'md-tasks' : undefined} style={{ margin: 0, paddingLeft: tasks ? 0 : 20, color: t.text.primary, display: 'flex', flexDirection: 'column', gap: 4, ...canvasTypography.body }}>
          {block.items.map((item, n) => {
            const struck = unstruck(item.text) !== item.text;
            return (
            <li key={itemKeys[n]} style={{ marginLeft: item.depth * 16, listStyle: tasks ? 'none' : undefined, display: tasks ? 'flex' : undefined, gap: 8 }}>
              {item.checked !== undefined && (
                <button
                  type="button"
                  className="md-check"
                  aria-label={ctx.checkLabel}
                  aria-pressed={item.checked}
                  onClick={() => ctx.apply(checkboxEdit(ctx.source, item.line, !item.checked))}
                >
                  <CheckIcon checked={item.checked} />
                </button>
              )}
              <Editable
                as="span"
                md={item.text}
                revision={ctx.source}
                onCommit={(text) => edit(text, { item: n })}
                style={{ flex: 1, minWidth: 0, color: item.checked || struck ? t.text.tertiary : undefined }}
              />
              {item.checked !== undefined && (
                <button
                  type="button"
                  className="md-strike"
                  title={ctx.strikeLabel}
                  aria-label={ctx.strikeLabel}
                  aria-pressed={struck}
                  onClick={() => ctx.apply(strikeEdit(ctx.source, item.line, !struck))}
                >
                  <StrikeIcon />
                </button>
              )}
            </li>
            );
          })}
        </Tag>
      );
    }
    case 'table':
      return (
        <Table
          headers={block.headers.map((h, c) => (
            <Editable key={c} as="span" md={h} revision={ctx.source} multiline={false} onCommit={(text) => edit(text, { cell: [-1, c] })} />
          ))}
          rows={block.rows.map((row, r) =>
            block.headers.map((_, c) => <Editable key={c} as="span" md={row[c] ?? ''} revision={ctx.source} multiline={false} onCommit={(text) => edit(text, { cell: [r, c] })} />),
          )}
          columnAlign={block.align}
        />
      );
    case 'code':
      return (
        <pre className="md-code" style={{ margin: 0, padding: 12, borderRadius: 8, background: t.fill.quaternary, border: `1px solid ${t.stroke.tertiary}`, overflowX: 'auto', fontSize: 12, lineHeight: '18px' }}>
          <Editable as="code" md={block.text} revision={ctx.source} plain onCommit={edit} style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', display: 'block', whiteSpace: 'pre' }} />
        </pre>
      );
    case 'quote':
      return (
        <Callout tone="neutral">
          <Editable md={block.text} revision={ctx.source} onCommit={edit} />
        </Callout>
      );
    case 'figure':
      return <FigureBlock name={block.name} />;
    case 'details':
      return (
        <CollapsibleSection title={block.summary} defaultOpen={block.open}>
          <Blocks blocks={block.blocks} ctx={ctx} />
        </CollapsibleSection>
      );
    case 'rule':
      return <Divider />;
  }
}

/** 블록 내용으로 만든 key. 위쪽에 문단이 늘어 줄 번호가 밀려도 다른 블록을 다시 그리지 않아, 고치던 글의 커서를 지킨다. */
function blockKey(block: Block): string {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'code':
    case 'quote':
      return `${block.kind}:${block.text}`;
    // 목록·표는 안의 항목·칸을 고쳐도 그대로 두어야 하므로 순서로만 구분한다.
    case 'list':
    case 'table':
      return block.kind;
    case 'figure':
      return `figure:${block.name}`;
    case 'details':
      return `details:${block.summary}`;
    case 'rule':
      return 'rule';
  }
}

/** 같은 내용의 블록이 여러 개면 순번을 붙인다. */
function uniqueKeys<T>(items: T[], keyOf: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = keyOf(item);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n ? `${key}#${n}` : key;
  });
}

function Blocks({ blocks, ctx }: { blocks: Block[]; ctx: BlockContext }) {
  const keys = uniqueKeys(blocks, blockKey);
  return (
    <Stack gap={10}>
      {blocks.map((block, i) => {
        const next = blocks[i + 1];
        // 내용 없는 절은 입력할 자리를 보여 준다.
        const emptyAfter = block.kind === 'heading' && (!next || (next.kind === 'heading' && next.level <= block.level));
        return <BlockView key={keys[i]} block={block} ctx={ctx} emptyAfter={emptyAfter} />;
      })}
    </Stack>
  );
}

/** md 문서를 바로 고칠 수 있게 그린다. */
export function EditableMarkdown({ dir, target, source, options }: { dir: string; target: DocTarget; source: string; options?: DocumentOptions }) {
  const t = useT();
  const { skipTitle, demote = 0 } = options ?? {};
  const blocks = useMemo(() => {
    let all = parseMarkdown(source);
    if (skipTitle && all[0]?.kind === 'heading' && all[0].level === 1) all = all.slice(1);
    return all.map((b) => (b.kind === 'heading' ? { ...b, level: Math.min(6, b.level + demote) } : b));
  }, [source, skipTitle, demote]);
  const ctx: BlockContext = {
    source,
    apply: (edit) => {
      if (edit) send({ type: 'editDocText', dir, target, base: source, ...edit });
    },
    placeholder: t('edit.placeholder'),
    checkLabel: t('edit.check'),
    strikeLabel: t('edit.strike'),
  };
  if (blocks.length === 0) {
    return (
      <Editable
        as="p"
        md=""
        revision={source}
        placeholder={t('edit.placeholder')}
        style={{ margin: 0, ...canvasTypography.body }}
        onCommit={(text) => ctx.apply(insertParagraphs(source, undefined, text))}
      />
    );
  }
  return <Blocks blocks={blocks} ctx={ctx} />;
}

/** 카드 제목·설명처럼 카드 정보에 바로 쓰는 글 */
export function EditableField({
  value,
  onCommit,
  multiline,
  placeholder,
  style,
}: {
  value: string;
  onCommit: (text: string) => void;
  multiline?: boolean;
  placeholder?: string;
  style?: CSSProperties;
}) {
  return <Editable as="div" md={value} revision={value} plain multiline={multiline} placeholder={placeholder} onCommit={onCommit} style={style} />;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function textAt(e: MouseEvent, target: Element): { node?: Text; text: string } {
  const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  const node = range?.startContainer;
  if (node instanceof Text && target.contains(node) && norm(node.data)) return { node, text: norm(node.data) };
  return { text: target.childElementCount === 0 ? norm(target.textContent ?? '') : '' };
}

function textNodes(root: Element, text: string): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (norm((n as Text).data) === text) out.push(n as Text);
  return out;
}

/**
 * 같은 글자가 코드 여러 곳에 있으면, 같은 괄호에 함께 적힌 글자(표의 한 행 등)가 누른 곳 가까이 보이는 쪽을 고른다.
 * 누른 곳에서 바깥 요소로 넓혀 가다가 처음 겹치는 글자가 나온 단계에서 한 곳만 가장 많이 겹치면 그곳이다.
 */
export function pickByContext(candidates: CanvasLiteral[], literals: CanvasLiteral[], text: string, node: Node, zone: Element): CanvasLiteral | undefined {
  const siblings = candidates.map(
    (c) =>
      new Set(
        c.group === undefined || c.group < 0
          ? []
          : literals.filter((l) => l !== c && l.group === c.group).map((l) => norm(l.value)).filter((v) => v && v !== text),
      ),
  );
  for (let el = node.parentElement; el && zone.contains(el); el = el.parentElement) {
    const seen = new Set<string>();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) seen.add(norm((n as Text).data));
    const scores = siblings.map((s) => [...s].filter((v) => seen.has(v)).length);
    const best = Math.max(...scores);
    if (best === 0) continue;
    return scores.filter((s) => s === best).length === 1 ? candidates[scores.indexOf(best)] : undefined;
  }
  return undefined;
}

interface Popover {
  x: number;
  y: number;
  text: string;
  figure?: string;
  candidates: CanvasLiteral[];
  chosen?: CanvasLiteral;
}

/**
 * 그림·canvas가 그린 영역(`data-code-zone`)의 글자를 두 번 눌러 고친다.
 * 코드에 직접 쓴 문자열이면 그 자리에서 바로 고치고, 같은 글자가 여러 곳이면 화면 순서로 고른다.
 * 정할 수 없거나 코드로 만든 글자면 작은 창으로 고를 곳이나 다른 방법(코드·에이전트)을 보여 준다.
 */
export function CodeEditLayer({ dir, payload, canAsk, children }: { dir: string; payload: CanvasPayload; canAsk: boolean; children: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<Popover>();
  const [value, setValue] = useState('');
  const [instruction, setInstruction] = useState('');

  useEffect(() => setPop(undefined), [payload.source]);

  const saveLiteral = (literal: CanvasLiteral, text: string) => {
    if (payload.source === undefined || norm(text) === norm(literal.value)) return;
    send({ type: 'editDocText', dir, target: 'code', base: payload.source, start: literal.start, end: literal.end, text, literal: true });
  };

  /** 글자만 든 요소를 그 자리에서 고친다. 저장하면 코드가 바뀌어 문서가 다시 그려진다. */
  const editInPlace = (el: HTMLElement, literal: CanvasLiteral) => {
    const original = el.textContent ?? '';
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      el.removeAttribute('contenteditable');
      el.classList.remove('md-editing');
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('blur', onBlur);
      const text = el.innerText.replace(/\u00a0/g, ' ').trim();
      // 저장하면 고친 글자를 그대로 두고, 새 코드가 오면 그림이 다시 그려진다.
      if (!save || norm(text) === norm(literal.value)) el.textContent = original;
      else saveLiteral(literal, text);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        finish(true);
      }
    };
    const onBlur = () => finish(true);
    el.setAttribute('contenteditable', 'true');
    el.classList.add('md-editing');
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onBlur);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const onDoubleClick = (e: MouseEvent) => {
    const target = e.target as Element;
    if (!ref.current || target.closest('.literal-pop, [contenteditable]')) return;
    const zone = target.closest('[data-code-zone]');
    if (!zone) return;
    const { node, text } = textAt(e, target);
    if (!text) return;
    e.preventDefault();
    const literals = payload.literals ?? [];
    const exact = literals.filter((l) => norm(l.value) === text);
    // inline Markdown 처리로 쪼개진 글자는 그 글자를 포함한 문자열을 찾는다.
    const candidates = exact.length ? exact : text.length >= 2 ? literals.filter((l) => norm(l.value).includes(text)) : [];
    let chosen = candidates.length === 1 ? candidates[0] : undefined;
    if (!chosen && candidates.length > 1 && node) chosen = pickByContext(candidates, literals, text, node, zone);
    if (!chosen && exact.length > 1 && node) {
      const nodes = textNodes(ref.current, text);
      if (nodes.length === exact.length) chosen = exact[nodes.indexOf(node)];
    }
    const el = node?.parentElement;
    if (chosen && el && el.childElementCount === 0 && norm(el.textContent ?? '') === norm(chosen.value)) {
      editInPlace(el, chosen);
      return;
    }
    const rect = ref.current.getBoundingClientRect();
    setPop({
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width - 380)),
      y: e.clientY - rect.top + 12,
      text,
      figure: zone.getAttribute('data-figure') ?? undefined,
      candidates,
      chosen,
    });
    setValue(chosen?.value ?? '');
    setInstruction('');
  };

  const showCode = (line?: number) => send({ type: 'openCanvasFile', dir, line });
  const figureLine = pop?.figure ? payload.figureLines?.[pop.figure] : undefined;
  const ask = (msg: ToExtension) => {
    send(msg);
    setPop(undefined);
  };

  return (
    <div ref={ref} className="code-edit-layer" onDoubleClick={onDoubleClick}>
      {children}
      {pop && (
        <div className="literal-pop" style={{ left: pop.x, top: pop.y }} role="dialog">
          {pop.chosen ? (
            <>
              <span className="muted small">{t('edit.line', { path: payload.codePath ?? '', line: pop.chosen.line })}</span>
              <textarea
                value={value}
                autoFocus
                rows={Math.min(8, Math.max(2, Math.ceil(value.length / 40)))}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setPop(undefined);
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    saveLiteral(pop.chosen!, value);
                    setPop(undefined);
                  }
                }}
              />
              <div className="role-actions">
                <button
                  className="primary"
                  disabled={value === pop.chosen.value}
                  onClick={() => {
                    saveLiteral(pop.chosen!, value);
                    setPop(undefined);
                  }}
                >
                  {t('edit.save')}
                </button>
                <button onClick={() => setPop(undefined)}>{t('edit.cancel')}</button>
                <span className="spacer" />
                <button className="link-button" onClick={() => showCode(pop.chosen!.line)}>
                  {t('edit.showCode')}
                </button>
              </div>
            </>
          ) : pop.candidates.length > 1 ? (
            <>
              <span>{t('edit.pick')}</span>
              {pop.candidates.map((c) => (
                <button
                  key={c.start}
                  className="literal-choice"
                  onClick={() => {
                    setPop({ ...pop, chosen: c });
                    setValue(c.value);
                  }}
                >
                  <span className="muted small">{t('edit.lineShort', { line: c.line })}</span> {c.value.length > 60 ? `${c.value.slice(0, 60)}…` : c.value}
                </button>
              ))}
              <button onClick={() => setPop(undefined)}>{t('edit.cancel')}</button>
            </>
          ) : (
            <>
              <span>{t('edit.computed')}</span>
              {canAsk && (
                <>
                  <textarea value={instruction} rows={2} placeholder={t('edit.askPlaceholder')} onChange={(e) => setInstruction(e.target.value)} />
                  <button
                    className="primary"
                    disabled={!instruction.trim()}
                    onClick={() =>
                      ask({
                        type: 'canvasAction',
                        dir,
                        action: {
                          type: 'newComposerChat',
                          userPrompt: `In ${payload.codePath}${pop.figure ? ` (figure ${pop.figure})` : ''}, change the part of the document that shows "${pop.text}": ${instruction.trim()}`,
                        },
                      })
                    }
                  >
                    {t('edit.askAgent')}
                  </button>
                </>
              )}
              <div className="role-actions">
                <button onClick={() => showCode(figureLine)}>{t('edit.showCode')}</button>
                <button onClick={() => setPop(undefined)}>{t('edit.cancel')}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
