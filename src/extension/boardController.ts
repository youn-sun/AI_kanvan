// 보드 웹뷰와 저장소를 잇는다. 상태 판단은 core/에 맡기고 여기서는 입출력만 처리한다.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChecklistMismatchError, progressOf, toggleChecklistItem } from '../core/checklist';
import { moveCard, orderBetween, unmetDoneConditions } from '../core/status';
import { normalizeTags, validateCategory, validateDates, validateDependencies, validateSettings } from '../core/board';
import {
  CATEGORY_COLORS,
  DEFAULT_SETTINGS,
  DOC_CATEGORIES,
  TOOL_IDS,
  type BoardConfig,
  type BoardSettings,
  type Card,
  type DocCategory,
  type Progress,
  type SharedDoc,
  type TaskDoc,
  type ToolId,
} from '../core/types';
import { docHistory } from '../runner/git';
import type { BoardAccess } from '../runner/runService';
import { pathExists, writeFileAtomic } from '../storage/fsutil';
import { BOARD_DIR, BoardRepository, type BoardSnapshot } from '../storage/repository';
import { RULES_DIR, RulesSync } from '../storage/rulesSync';
import { normalizeScope, setSectionTools } from '../core/agentRules';
import { translate, type Locale, type MessageKey } from '../shared/i18n';
import type { BoardState, CardPatch, CardView, MachineSettings, RulesState, ToExtension, ToWebview } from '../shared/protocol';
import { figuresFileFor, sharedDocKind, type CanvasController } from './canvasController';
import { NO_RUNS, type RunsBridge } from './runsBridge';
import { renderWebviewHtml } from './webviewHtml';

const RELOAD_DEBOUNCE_MS = 100;

export class BoardController implements BoardAccess, vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private snapshot?: BoardSnapshot;
  private initialized = false;
  private reloadTimer?: NodeJS.Timeout;
  private readonly watchedDocs = new Map<string, string | undefined>();
  private sharedDocWatchers: vscode.Disposable[] = [];
  private missingWorktrees = new Set<string>();
  private sharedDocMeta: BoardState['sharedDocMeta'] = {};
  private reloading: Promise<unknown> = Promise.resolve();
  private saveGeneration = 0;
  private gitignoreChecked = false;
  private readonly rules: RulesSync;
  private rulesState: RulesState = { files: [], importable: [], duplicates: [] };
  private readonly disposables: vscode.Disposable[] = [];
  runs: RunsBridge = NO_RUNS;
  /** 카드 문서 탭의 canvas (TASK-3) */
  canvas?: CanvasController;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly repo: BoardRepository,
    readonly locale: Locale,
  ) {
    this.rules = new RulesSync(repo.root, repo.localDir, locale);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repo.root, `${BOARD_DIR}/**`));
    // S-7, M-2: 외부 편집·체크아웃·pull로 파일이 바뀌면 다시 읽는다.
    watcher.onDidChange(() => this.scheduleReload());
    watcher.onDidCreate(() => this.scheduleReload());
    watcher.onDidDelete(() => this.scheduleReload());
    this.disposables.push(
      watcher,
      vscode.window.onDidChangeWindowState((s) => s.focused && this.scheduleReload()),
    );
  }

  t(key: MessageKey, params?: Record<string, string | number>): string {
    return translate(this.locale, key, params);
  }

  dispose(): void {
    clearTimeout(this.reloadTimer);
    this.panel?.dispose();
    this.sharedDocWatchers.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('agentBoard', 'Agent Board', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    });
    panel.webview.html = renderWebviewHtml(panel.webview, this.context.extensionUri, this.locale);
    panel.webview.onDidReceiveMessage((msg: ToExtension) => this.handle(msg).catch((err) => this.showError(err)));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.watchedDocs.clear();
    });
    this.panel = panel;
  }

  scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload().catch((err) => this.showError(err)), RELOAD_DEBOUNCE_MS);
  }

  /** reload는 한 번에 하나씩 실행한다. 겹치면 먼저 시작한 쪽이 이전 스냅샷을 되살릴 수 있다. */
  reload(): Promise<void> {
    const next = this.reloading.then(() => this.reloadNow());
    this.reloading = next.catch(() => undefined);
    return next;
  }

  private async reloadNow(): Promise<void> {
    this.initialized = await this.repo.isInitialized();
    // S-1: 다른 사람이 만든 보드를 받아 열었을 때도 local/이 Git에 올라가지 않게 한다.
    if (this.initialized && !this.gitignoreChecked) {
      this.gitignoreChecked = true;
      await this.repo.ensureGitignore();
    }
    if (this.initialized) await this.runs.beforeReload();
    // 읽는 동안 저장이 있었으면 다시 읽는다. 오래된 카드로 메모리를 덮지 않게 한다.
    let snapshot: BoardSnapshot | undefined;
    for (;;) {
      const generation = this.saveGeneration;
      snapshot = this.initialized ? await this.repo.load() : undefined;
      if (generation === this.saveGeneration) break;
    }
    this.snapshot = snapshot;
    if (snapshot && !snapshot.boardError) this.rulesState = await this.rules.sync(snapshot.board);
    this.sharedDocMeta = await this.loadSharedDocMeta(snapshot);
    this.missingWorktrees = new Set();
    for (const card of this.cards) if (!(await this.worktreeExists(card))) this.missingWorktrees.add(card.id);
    this.refreshSharedDocWatchers();
    this.post({ type: 'state', state: this.buildState() });
    await this.refreshWatchedDocs();
    await this.canvas?.refresh();
  }

  /** 쓰기 직전에 디스크의 최신 카드를 읽는다. */
  private async freshCard(id: string): Promise<Card | undefined> {
    const dir = this.snapshot?.cards.find((c) => c.card?.id === id)?.dir ?? id;
    return (await this.repo.loadCard(dir)).card ?? this.findCard(id);
  }

  get loadedCards(): BoardSnapshot['cards'] {
    return this.snapshot?.cards ?? [];
  }

  get cards(): Card[] {
    return (this.snapshot?.cards ?? []).flatMap((c) => (c.card ? [c.card] : []));
  }

  findCard(id: string): Card | undefined {
    return this.cards.find((c) => c.id === id);
  }

  // ---- BoardAccess ----

  get root(): string {
    return this.repo.root;
  }

  getCard(id: string): Card | undefined {
    return this.findCard(id);
  }

  allCards(): Card[] {
    return this.cards;
  }

  /** 저장하고 메모리의 스냅샷도 바로 바꾼다. 다음 reload 전에 읽는 쪽이 최신 값을 보게 한다. */
  async saveCard(card: Card): Promise<void> {
    this.saveGeneration += 1;
    await this.repo.saveCard(card);
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        cards: this.snapshot.cards.map((c) => (c.card?.id === card.id ? { ...c, card } : c)),
      };
    }
    this.scheduleReload();
  }

  async progress(id: string): Promise<Progress> {
    return progressOf(await this.repo.readTaskDoc(id, 'plan'));
  }

  enabledTools(): ToolId[] {
    return this.snapshot?.board.enabledTools ?? [...TOOL_IDS];
  }

  /** 이 기기 설정 (VS Code 사용자 설정) */
  machineSettings(): MachineSettings {
    const config = vscode.workspace.getConfiguration('agentBoard');
    return {
      toolPaths: config.get<MachineSettings['toolPaths']>('toolPaths') ?? {},
      autoCreateCards: config.get<boolean>('autoCreateCards', true),
      matcherTool: config.get<MachineSettings['matcherTool']>('matcherTool', 'auto'),
    };
  }

  settings(): BoardSettings {
    return this.snapshot?.board.settings ?? DEFAULT_SETTINGS;
  }

  sharedDocs(): SharedDoc[] {
    return this.snapshot?.board.sharedDocs ?? [];
  }

  taskDocPath(id: string, doc: TaskDoc): string {
    return this.repo.taskDocPath(id, doc);
  }

  async moveByUser(id: string, to: Card['status']): Promise<void> {
    const last = this.cards.filter((c) => c.status === to && c.id !== id).sort((a, b) => a.order - b.order).at(-1);
    await this.move(id, to, last?.id);
  }

  refresh(): void {
    this.scheduleReload();
  }

  private buildState(): BoardState {
    const snap = this.snapshot;
    const cards: CardView[] = (snap?.cards ?? []).map((c) => ({
      dir: c.dir,
      card: c.card,
      error: c.error,
      errorDetail: c.errorDetail,
      progress: c.progress,
      duplicate: !!c.card && c.card.id in (snap?.duplicates ?? {}),
      runStatus: c.card ? this.runs.runStatus(c.card.id) : {},
      rereviewRequired: c.card ? this.runs.reviewSummary(c.card.id).rereviewRequired : false,
      worktreeMissing: !!c.card && this.missingWorktrees.has(c.card.id),
      tags: c.tags,
      hasCanvas: c.hasCanvas,
      sessions: c.card ? this.runs.cardSessions(c.card.id) : [],
      activity: c.card ? this.runs.cardActivity(c.card.id) : undefined,
    }));
    return {
      initialized: this.initialized,
      locale: this.locale,
      board: snap?.board,
      boardError: snap?.boardError,
      cards,
      sharedDocExists: snap?.sharedDocExists ?? {},
      sharedDocMeta: this.sharedDocMeta,
      tools: this.runs.tools(),
      unlinkedSessions: this.runs.unlinkedSessions(),
      hooksInstalled: this.runs.hooksInstalled(),
      hookTools: this.runs.hookToolList(),
      machine: this.machineSettings(),
      rules: this.rulesState,
    };
  }

  post(msg: ToWebview): void {
    void this.panel?.webview.postMessage(msg);
  }

  private showError(err: unknown): void {
    void vscode.window.showErrorMessage(`Agent Board: ${err instanceof Error ? err.message : String(err)}`);
  }

  async handle(msg: ToExtension): Promise<void> {
    if (await this.runs.handle(msg)) return;
    if (this.canvas && (await this.canvas.handle(msg))) return;
    switch (msg.type) {
      case 'ready':
        return this.reload();
      case 'init':
        await this.repo.init();
        return this.reload();
      case 'createCard':
        await this.createCard(msg.title);
        return this.reload();
      case 'updateCard':
        await this.updateCard(msg.id, msg.patch);
        return this.reload();
      case 'moveCard':
        await this.move(msg.id, msg.to, msg.beforeId, msg.afterId);
        return this.reload();
      case 'deleteCard':
        await this.deleteCard(msg.dir);
        return this.reload();
      case 'renumberCard': {
        const card = await this.repo.renumberCard(msg.dir);
        void vscode.window.showInformationMessage(this.t('msg.renumbered', { from: msg.dir, to: card.id }));
        return this.reload();
      }
      case 'openCardFile':
        return this.openFile(this.repo.cardFile(msg.dir));
      case 'openTaskDoc':
        return this.openFile(this.repo.taskDocPath(msg.dir, msg.doc));
      case 'watchDoc': {
        const content = await this.repo.readTaskDoc(msg.dir, msg.doc);
        this.watchedDocs.set(docKey(msg.dir, msg.doc), content);
        return this.post({ type: 'doc', dir: msg.dir, doc: msg.doc, content });
      }
      case 'unwatchDoc':
        this.watchedDocs.delete(docKey(msg.dir, msg.doc));
        return;
      case 'saveDoc':
        return this.saveDoc(msg.dir, msg.doc, msg.content, msg.base);
      case 'compareDoc':
        return this.compareDoc(msg.dir, msg.doc, msg.content);
      case 'toggleChecklist':
        return this.toggleChecklist(msg.dir, msg.line, msg.text, msg.checked);
      case 'addSharedDoc':
        return this.addSharedDoc();
      case 'openSharedDoc': {
        const doc = this.snapshot?.board.sharedDocs.find((d) => d.id === msg.id);
        if (doc) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(this.repo.root, doc.path)));
        return;
      }
      case 'renameSharedDoc':
        return this.editBoard(async (board) => {
          const doc = board.sharedDocs.find((d) => d.id === msg.id);
          const name = doc && (await vscode.window.showInputBox({ prompt: this.t('msg.sharedDocName'), value: doc.name }));
          if (!doc || !name) return undefined;
          return mapDoc(board, msg.id, { name });
        });
      case 'setSharedDocCategory':
        return this.editBoard(async (board) => mapDoc(board, msg.id, { category: msg.category }));
      case 'setSharedDocTags':
        return this.editBoard(async (board) => mapDoc(board, msg.id, { tags: knownTags(board, msg.tags) }));
      case 'relinkSharedDoc':
        return this.editBoard(async (board) => {
          const rel = await this.pickRepoFile();
          return rel ? mapDoc(board, msg.id, { path: rel }) : undefined;
        });
      case 'removeSharedDoc':
        return this.editBoard(async (board) => ({ ...board, sharedDocs: board.sharedDocs.filter((d) => d.id !== msg.id) }));
      case 'addRule':
        return this.addRule();
      case 'updateRule':
        return this.editBoard(async (board) => {
          const doc = board.sharedDocs.find((d) => d.id === msg.id);
          if (!doc?.rule) return undefined;
          const scope = msg.scope === undefined ? doc.rule.scope : normalizeScope(msg.scope);
          if (scope.split('/').includes('..') || path.isAbsolute(scope)) {
            void vscode.window.showWarningMessage(this.t('rules.badScope'));
            return undefined;
          }
          const tools = msg.tools ? TOOL_IDS.filter((t) => msg.tools!.includes(t)) : doc.rule.tools;
          const local = msg.local ?? doc.rule.local;
          return mapDoc(board, msg.id, { rule: { tools, scope, ...(local && { local }) } });
        });
      case 'setRuleSection': {
        const doc = this.snapshot?.board.sharedDocs.find((d) => d.id === msg.id);
        if (!doc?.rule) return;
        const file = path.join(this.repo.root, doc.path);
        const current = (await fs.readFile(file, 'utf8').catch(() => undefined)) ?? '';
        if (current !== msg.base) {
          void vscode.window.showWarningMessage(this.t('rules.changedOutside'));
          return this.reload();
        }
        await writeFileAtomic(file, setSectionTools(current, msg.line, msg.tools ?? undefined));
        return this.reload();
      }
      case 'removeRule': {
        const doc = this.snapshot?.board.sharedDocs.find((d) => d.id === msg.id);
        if (!doc) return;
        const ok = await vscode.window.showWarningMessage(this.t('rules.removeConfirm', { name: doc.name }), { modal: true }, this.t('rules.remove'));
        if (!ok) return;
        await this.editBoard(async (board) => ({ ...board, sharedDocs: board.sharedDocs.filter((d) => d.id !== msg.id) }));
        if (doc.path.startsWith(`${RULES_DIR}/`)) await fs.rm(path.join(this.repo.root, doc.path), { force: true });
        return this.reload();
      }
      case 'importRules':
        return this.importRules();
      case 'mergeRules':
        return this.editBoard(async (board) => {
          const keep = board.sharedDocs.find((d) => d.id === msg.keep);
          const drop = board.sharedDocs.find((d) => d.id === msg.drop);
          if (!keep?.rule || !drop?.rule) return undefined;
          const tools = TOOL_IDS.filter((t) => keep.rule!.tools.includes(t) || drop.rule!.tools.includes(t));
          const merged = mapDoc(board, keep.id, { rule: { ...keep.rule, tools } });
          return { ...merged, sharedDocs: merged.sharedDocs.filter((d) => d.id !== drop.id) };
        });
      case 'overwriteRuleFile': {
        const board = this.snapshot?.board;
        if (!board) return;
        this.rulesState = await this.rules.sync(board, new Set([msg.path]));
        return this.reload();
      }
      case 'compareRuleFile': {
        const file = this.rulesState.files.find((f) => f.path === msg.path);
        if (!file) return;
        const preview = await this.rules.writePreview(file);
        await vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.file(path.join(this.repo.root, file.path)),
          vscode.Uri.file(preview),
          this.t('rules.diffTitle', { path: file.path }),
        );
        return;
      }
      case 'openRuleFile':
        return this.openFile(path.join(this.repo.root, msg.path));
      case 'createDocTask': {
        const doc = this.snapshot?.board.sharedDocs.find((d) => d.id === msg.id);
        if (!doc) return;
        await this.createCard(this.t('shared.taskTitle', { name: doc.name }), [doc.id]);
        return this.reload();
      }
      case 'addCategory':
        return this.editBoard(async (board) => {
          const category = { tag: msg.tag.trim(), name: msg.name.trim(), color: msg.color };
          const error = validateCategory(category, board.categories);
          if (error) {
            this.post({ type: 'settingError', field: 'category', message: this.t(`error.${error}`) });
            return undefined;
          }
          return { ...board, categories: [...board.categories, category] };
        });
      case 'updateCategory':
        // 태그는 plan.md에 쓰이므로 바꾸지 않는다. 표시 이름과 색만 바꾼다 (ST-2).
        return this.editBoard(async (board) => {
          const name = msg.name?.trim();
          if (name !== undefined && (name.length < 1 || name.length > 30)) {
            this.post({ type: 'settingError', field: `category:${msg.tag}`, message: this.t('error.invalid_name') });
            return undefined;
          }
          if (msg.color !== undefined && !CATEGORY_COLORS.includes(msg.color)) return undefined;
          return {
            ...board,
            categories: board.categories.map((c) =>
              c.tag === msg.tag ? { ...c, ...(name !== undefined ? { name } : {}), ...(msg.color ? { color: msg.color } : {}) } : c,
            ),
          };
        });
      case 'moveCategory':
        return this.editBoard(async (board) => {
          const list = [...board.categories];
          const i = list.findIndex((c) => c.tag === msg.tag);
          const j = i + msg.offset;
          if (i < 0 || j < 0 || j >= list.length) return undefined;
          [list[i], list[j]] = [list[j]!, list[i]!];
          return { ...board, categories: list };
        });
      case 'deleteCategory':
        return this.editBoard(async (board) => {
          const category = board.categories.find((c) => c.tag === msg.tag);
          if (!category) return undefined;
          // ST-3: 미분류가 될 항목 수를 보여 주고 확인을 받는다. plan.md는 바꾸지 않는다.
          const key = category.tag.toLowerCase();
          const count = (this.snapshot?.cards ?? []).reduce((n, c) => n + (normalizeTags(c.tags, board.categories)[key]?.total ?? 0), 0);
          const ok = this.t('settings.delete');
          const choice = await vscode.window.showWarningMessage(
            this.t('msg.deleteCategory', { name: category.name, count }),
            { modal: true },
            ok,
          );
          if (choice !== ok) return undefined;
          return { ...board, categories: board.categories.filter((c) => c.tag !== msg.tag) };
        });
      case 'setToolEnabled':
        return this.editBoard(async (board) => {
          const set = new Set(board.enabledTools);
          if (msg.enabled) set.add(msg.tool);
          else set.delete(msg.tool);
          return { ...board, enabledTools: TOOL_IDS.filter((t) => set.has(t)) };
        });
      case 'updateBoardSettings':
        return this.editBoard(async (board) => {
          const invalid = validateSettings(msg.patch);
          if (invalid) {
            this.post({ type: 'settingError', field: invalid, message: this.t(`error.range_${invalid}`) });
            return undefined;
          }
          return { ...board, settings: { ...board.settings, ...msg.patch } };
        });
      case 'setMachineSetting':
        // ST-1: "이 기기" 설정은 VS Code 사용자 설정에 둔다.
        await vscode.workspace.getConfiguration('agentBoard').update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        return this.reload();
      default:
        return;
    }
  }

  async createCard(title: string, relatedDocs?: string[]): Promise<Card | undefined> {
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    if (!(await this.repo.isInitialized())) await this.repo.init();
    const todo = this.cards.filter((c) => c.status === 'todo');
    const order = orderBetween(todo.length ? Math.max(...todo.map((c) => c.order)) : undefined, undefined);
    let card = await this.repo.createCard({ title: trimmed, relatedDocs }, order);
    // ST-5: 새 카드의 자동 수정·재리뷰 기본값
    if (this.settings().defaultAutoReview) {
      card = { ...card, autoReview: true };
      await this.repo.saveCard(card);
    }
    await this.rememberCard(card);
    return card;
  }

  /** 다음 reload 전에도 getCard가 새 카드를 찾도록 스냅샷에 넣는다. 없으면 세션 연결이 실패한다 (E-11). */
  private async rememberCard(card: Card): Promise<void> {
    if (!this.snapshot || this.snapshot.cards.some((c) => c.card?.id === card.id)) return;
    const loaded = await this.repo.loadCard(card.id);
    this.snapshot = { ...this.snapshot, cards: [...this.snapshot.cards, { ...loaded, card }] };
  }

  private async updateCard(id: string, patch: CardPatch): Promise<void> {
    const card = await this.freshCard(id);
    if (!card) return;
    const next: Card = { ...card, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined && patch.title.trim()) next.title = patch.title.trim();
    if (patch.description !== undefined) next.description = patch.description || undefined;
    if (patch.relatedDocs !== undefined) next.relatedDocs = patch.relatedDocs;
    if (patch.autoReview !== undefined) next.autoReview = patch.autoReview;
    // TASK-2 CD-3, CD-4: 일정과 선행 카드는 검증을 통과해야 저장한다.
    if (patch.startDate !== undefined) next.startDate = patch.startDate || undefined;
    if (patch.dueDate !== undefined) next.dueDate = patch.dueDate || undefined;
    const dateError = validateDates(next.startDate, next.dueDate);
    if (dateError) {
      void vscode.window.showWarningMessage(this.t(`error.${dateError}`));
      return this.reload();
    }
    if (patch.dependsOn !== undefined) {
      const depError = validateDependencies(card.id, patch.dependsOn, this.cards);
      if (depError) {
        void vscode.window.showWarningMessage(this.t(`error.dep_${depError}`));
        return this.reload();
      }
      next.dependsOn = patch.dependsOn.length ? patch.dependsOn : undefined;
    }
    if (patch.agents) {
      const agents = { ...card.agents };
      for (const [role, value] of Object.entries(patch.agents) as [keyof typeof agents, (typeof agents)['implementer'] | null][]) {
        if (value) agents[role] = value;
        else delete agents[role];
      }
      next.agents = agents;
    }
    await this.saveCard(next);
  }

  /** 사용자가 카드를 옮긴다. 상태 이동 규칙은 core/status의 moveCard가 정한다. */
  async move(id: string, to: Card['status'], beforeId?: string, afterId?: string): Promise<void> {
    const card = this.findCard(id);
    const loaded = this.snapshot?.cards.find((c) => c.card?.id === id);
    if (!card || !loaded) return;
    const order = orderBetween(this.findCard(beforeId ?? '')?.order, this.findCard(afterId ?? '')?.order);
    let unmet: ReturnType<typeof unmetDoneConditions> | undefined;
    if (to === 'done' && card.status !== 'done') {
      unmet = unmetDoneConditions(loaded.progress, this.runs.reviewSummary(id));
      if (unmet.length > 0) {
        const detail = unmet.map((u) => `• ${this.t(`unmet.${u}`)}`).join('\n');
        const choice = await vscode.window.showWarningMessage(
          this.t('msg.manualDone', { id }),
          { modal: true, detail },
          this.t('msg.markDone'),
        );
        if (choice !== this.t('msg.markDone')) return;
      }
    }
    // 확인 대화상자가 열린 동안 바뀐 내용(worktree 등)을 잃지 않게 다시 읽는다.
    const latest = (await this.freshCard(id)) ?? card;
    const result = moveCard(latest, to, {
      now: new Date().toISOString(),
      hasActiveRun: this.runs.hasActiveRun(id),
      unmet,
      order,
    });
    await this.saveCard(result.card);
    for (const effect of result.effects) if (effect.kind === 'stopRuns') await this.runs.stopAll(result.card);
  }

  private async deleteCard(dir: string): Promise<void> {
    const loaded = this.snapshot?.cards.find((c) => c.dir === dir);
    const id = loaded?.card?.id ?? dir;
    if (this.runs.hasActiveRun(id)) {
      void vscode.window.showWarningMessage(this.t('msg.deleteRunning', { id }));
      return;
    }
    const withDocs = this.t('msg.deleteDocs');
    const keepDocs = this.t('msg.keepDocs');
    const choice = await vscode.window.showWarningMessage(
      this.t('msg.deleteCard', { id, title: loaded?.card?.title ?? '' }),
      { modal: true },
      withDocs,
      keepDocs,
    );
    if (choice !== withDocs && choice !== keepDocs) return;
    await this.repo.deleteCard(dir, choice === withDocs);
    // CD-3: 지운 카드를 선행 카드로 둔 카드에서 뺀다.
    for (const other of this.cards.filter((c) => c.dependsOn?.includes(id))) {
      const fresh = (await this.freshCard(other.id)) ?? other;
      const dependsOn = (fresh.dependsOn ?? []).filter((d) => d !== id);
      await this.saveCard({ ...fresh, dependsOn: dependsOn.length ? dependsOn : undefined, updatedAt: new Date().toISOString() });
    }
  }

  private async openFile(file: string): Promise<void> {
    if (!(await pathExists(file))) await writeFileAtomic(file, '');
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  private async refreshWatchedDocs(): Promise<void> {
    for (const [key, last] of this.watchedDocs) {
      const [dir, doc] = splitDocKey(key);
      const content = await this.repo.readTaskDoc(dir, doc);
      if (content !== last) {
        this.watchedDocs.set(key, content);
        this.post({ type: 'doc', dir, doc, content });
      }
    }
  }

  /** M-3: 편집을 시작한 뒤 파일이 바뀌었으면 덮어쓰지 않고 충돌을 알린다. */
  private async saveDoc(dir: string, doc: TaskDoc, content: string, base: string | undefined): Promise<void> {
    const current = await this.repo.readTaskDoc(dir, doc);
    if (current !== base) {
      this.post({ type: 'docConflict', dir, doc, fileContent: current });
      return;
    }
    await this.repo.writeTaskDoc(dir, doc, content);
    this.watchedDocs.set(docKey(dir, doc), content);
    this.post({ type: 'docSaved', dir, doc, content });
  }

  private async compareDoc(dir: string, doc: TaskDoc, content: string): Promise<void> {
    const mine = path.join(this.repo.localDir, 'compare', dir, `${doc}.mine.md`);
    await writeFileAtomic(mine, content);
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(this.repo.taskDocPath(dir, doc)),
      vscode.Uri.file(mine),
      `${dir}/${doc}.md ↔ ${this.t('editor.keepMine')}`,
    );
  }

  private async toggleChecklist(dir: string, line: number, text: string, checked: boolean): Promise<void> {
    const content = (await this.repo.readTaskDoc(dir, 'plan')) ?? '';
    try {
      await this.repo.writeTaskDoc(dir, 'plan', toggleChecklistItem(content, line, text, checked));
    } catch (err) {
      if (!(err instanceof ChecklistMismatchError)) throw err;
      void vscode.window.showInformationMessage(this.t('msg.checklistMismatch'));
    }
    await this.reload();
  }

  private async pickRepoFile(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(this.repo.root),
      canSelectMany: false,
      openLabel: this.t('msg.pickSharedDoc'),
    });
    if (!picked?.[0]) return undefined;
    const rel = this.repo.relativeToRoot(picked[0].fsPath);
    if (!rel) void vscode.window.showWarningMessage(this.t('msg.outsideRepo'));
    return rel;
  }

  private async addSharedDoc(): Promise<void> {
    const rel = await this.pickRepoFile();
    if (!rel) return;
    const name = await vscode.window.showInputBox({ prompt: this.t('msg.sharedDocName'), value: path.basename(rel) });
    if (!name) return;
    const pick = await vscode.window.showQuickPick(
      DOC_CATEGORIES.map((c) => ({ label: this.t(`category.${c}`), category: c })),
      { placeHolder: this.t('msg.sharedDocCategory') },
    );
    if (!pick) return;
    const tags = await vscode.window.showQuickPick(
      (this.snapshot?.board.categories ?? []).map((c) => ({ label: c.name, description: `[${c.tag}]`, tag: c.tag })),
      { placeHolder: this.t('shared.pickTags'), canPickMany: true },
    );
    if (!tags) return;
    await this.editBoard(async (board) =>
      this.repo.addSharedDoc(board, { name, category: pick.category as DocCategory, path: rel, tags: knownTags(board, tags.map((x) => x.tag)) }),
    );
  }

  private async addRule(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: this.t('rules.newName') });
    if (!name?.trim()) return;
    const used = new Set(this.snapshot?.board.sharedDocs.map((d) => d.path));
    const stem = name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'rule';
    let rel = `${RULES_DIR}/${stem}.md`;
    for (let n = 2; used.has(rel) || (await pathExists(path.join(this.repo.root, rel))); n += 1) rel = `${RULES_DIR}/${stem}-${n}.md`;
    await writeFileAtomic(path.join(this.repo.root, rel), `# ${name.trim()}\n\n`);
    await this.editBoard(async (board) =>
      this.repo.addSharedDoc(board, { name: name.trim(), category: 'convention', path: rel, tags: [], rule: { tools: [...board.enabledTools], scope: '' } }),
    );
  }

  /** 보드가 만들지 않은 CLAUDE.md·AGENTS.md·.cursor/rules를 규칙으로 옮기고, 그 자리에 보드가 만든 파일을 쓴다. */
  private async importRules(): Promise<void> {
    const files = this.rulesState.importable;
    if (files.length === 0) return;
    const ok = await vscode.window.showWarningMessage(
      this.t('rules.importConfirm', { files: files.join(', ') }),
      { modal: true },
      this.t('rules.import'),
    );
    if (!ok) return;
    let result: Awaited<ReturnType<RulesSync['importFiles']>> | undefined;
    await this.editBoard(async (board) => {
      result = await this.rules.importFiles(board);
      return result.board;
    });
    if (!result) return;
    this.rulesState = await this.rules.sync(result.board, new Set(result.replaced));
    await this.rules.removeMoved(result.moved);
    void vscode.window.showInformationMessage(this.t('rules.imported', { n: result.replaced.length }));
    return this.reload();
  }

  /** 공용 문서 표의 일자·브랜치. 파일이 없는 문서는 비워 둔다 (D-2, D-3). */
  private async loadSharedDocMeta(snap: BoardSnapshot | undefined): Promise<BoardState['sharedDocMeta']> {
    const docs = (snap?.board.sharedDocs ?? []).filter((d) => snap?.sharedDocExists[d.id]);
    if (docs.length === 0) return {};
    const history = await docHistory(this.repo.root, docs.map((d) => d.path));
    return Object.fromEntries(docs.map((d) => [d.id, { date: history.dates[d.path], branch: history.branch }]));
  }

  /** board.json에 충돌이 있으면 편집하지 않는다 (S-7). */
  /** board.json을 고친다. 병합 충돌이 있으면 고치지 않는다 (S-7, ST-8). */
  private async editBoard(edit: (board: BoardConfig) => Promise<BoardConfig | undefined>): Promise<void> {
    const snap = this.snapshot;
    if (!snap || snap.boardError) {
      void vscode.window.showWarningMessage(this.t(snap?.boardError === 'invalid' ? 'board.boardInvalid' : 'board.boardConflict'));
      return;
    }
    const next = await edit(snap.board);
    if (next && next !== snap.board) await this.repo.saveBoard(next);
    await this.reload();
  }

  private refreshSharedDocWatchers(): void {
    this.sharedDocWatchers.forEach((d) => d.dispose());
    // Markdown 공용 문서는 옆의 그림 파일(`.canvas.tsx`)도 지켜본다.
    const paths = (this.snapshot?.board.sharedDocs ?? []).flatMap((doc) =>
      sharedDocKind(doc.path) === 'markdown' ? [doc.path, figuresFileFor(doc.path)] : [doc.path],
    );
    this.sharedDocWatchers = paths.map((rel) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.repo.root, rel));
      w.onDidCreate(() => this.scheduleReload());
      w.onDidDelete(() => this.scheduleReload());
      // 보드 안에서 보고 있는 공용 문서가 바뀌면 다시 그린다 (TASK-3).
      w.onDidChange(() => this.scheduleReload());
      return w;
    });
  }

  async worktreeExists(card: Card): Promise<boolean> {
    if (!card.workspace?.worktree) return true;
    return pathExists(path.resolve(this.repo.root, card.workspace.worktree));
  }

  async readDocFile(rel: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(this.repo.root, rel), 'utf8');
    } catch {
      return undefined;
    }
  }
}

function docKey(dir: string, doc: TaskDoc): string {
  return `${dir}\u0000${doc}`;
}

function splitDocKey(key: string): [string, TaskDoc] {
  const [dir, doc] = key.split('\u0000');
  return [dir!, doc as TaskDoc];
}

/** 보드에 있는 구분 태그만 남긴다. 순서는 보드의 구분 순서를 따른다. */
function knownTags(board: BoardConfig, tags: string[]): string[] {
  return board.categories.map((c) => c.tag).filter((tag) => tags.includes(tag));
}

function mapDoc(board: BoardConfig, id: string, patch: Partial<BoardConfig['sharedDocs'][number]>): BoardConfig {
  return { ...board, sharedDocs: board.sharedDocs.map((d) => (d.id === id ? { ...d, ...patch } : d)) };
}
