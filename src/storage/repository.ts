// 레포 안 `.agent-board/` 읽기·쓰기. spec 1절.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { APPROVAL_DOCS, approvalText } from '../core/approval';
import { tagProgress, type TagProgress } from '../core/board';
import { itemsProgress, parseChecklist } from '../core/checklist';
import { findDuplicateIds, isTaskId, nextTaskId } from '../core/ids';
import {
  CARD_SCHEMA_VERSION,
  TASK_DOCS,
  defaultBoard,
  type BoardConfig,
  type Card,
  type Progress,
  type SharedDoc,
  type TaskDoc,
} from '../core/types';
import { hasConflictMarkers, pathExists, readTextIfExists, toJson, writeFileAtomic } from './fsutil';
import { migrateBoard, migrateCard } from './migrate';
import { assertShareableBoard, assertShareableCard } from './shareable';
import { taskDocTemplate } from './templates';

export const BOARD_DIR = '.agent-board';
export const LOCAL_DIR = 'local';
const GITIGNORE_ENTRY = `${BOARD_DIR}/${LOCAL_DIR}/`;

export type CardLoadError = 'conflict' | 'invalid';

export interface LoadedCard {
  /** tasks/ 아래 폴더 이름 */
  dir: string;
  card?: Card;
  error?: CardLoadError;
  errorDetail?: string;
  progress: Progress;
  /** 구분별 진행률 (TASK-2 CT-2) */
  tags: TagProgress;
  /** 카드 폴더에 canvas.tsx가 있는지 (TASK-3 CP-2) */
  hasCanvas: boolean;
  /** 승인 대상 문서의 지금 내용 해시 */
  docsHash: string;
}

export interface BoardSnapshot {
  board: BoardConfig;
  boardError?: CardLoadError;
  cards: LoadedCard[];
  /** 같은 ID를 가진 카드 폴더 목록 (S-6) */
  duplicates: Record<string, string[]>;
  /** 공용 문서 ID → 파일 존재 여부 (D-3) */
  sharedDocExists: Record<string, boolean>;
}

export interface NewCardInput {
  title: string;
  description?: string;
  relatedDocs?: string[];
}

export class BoardRepository {
  constructor(
    readonly root: string,
    private readonly locale: 'ko' | 'en' = 'ko',
  ) {}

  get boardDir(): string {
    return path.join(this.root, BOARD_DIR);
  }
  get localDir(): string {
    return path.join(this.boardDir, LOCAL_DIR);
  }
  private get tasksDir(): string {
    return path.join(this.boardDir, 'tasks');
  }
  private get tombstoneDir(): string {
    return path.join(this.boardDir, 'deleted');
  }
  private get boardFile(): string {
    return path.join(this.boardDir, 'board.json');
  }

  taskDir(dir: string): string {
    return path.join(this.tasksDir, dir);
  }
  taskDocPath(dir: string, doc: TaskDoc): string {
    return path.join(this.taskDir(dir), `${doc}.md`);
  }
  canvasPath(dir: string): string {
    return path.join(this.taskDir(dir), 'canvas.tsx');
  }
  cardFile(dir: string): string {
    return path.join(this.taskDir(dir), 'card.json');
  }

  async isInitialized(): Promise<boolean> {
    return pathExists(this.boardFile);
  }

  /** 보드 폴더와 board.json을 만들고 `.gitignore`에 local/을 추가한다 (S-1). */
  async init(): Promise<void> {
    await fs.mkdir(this.tasksDir, { recursive: true });
    await fs.mkdir(this.localDir, { recursive: true });
    if (!(await pathExists(this.boardFile))) {
      const board = defaultBoard();
      await writeFileAtomic(this.boardFile, toJson(board));
    }
    await this.ensureGitignore();
  }

  async ensureGitignore(): Promise<void> {
    const file = path.join(this.root, '.gitignore');
    const current = (await readTextIfExists(file)) ?? '';
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    const covered = [GITIGNORE_ENTRY, `/${GITIGNORE_ENTRY}`, GITIGNORE_ENTRY.slice(0, -1), `/${GITIGNORE_ENTRY.slice(0, -1)}`];
    if (lines.some((l) => covered.includes(l))) return;
    const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    await writeFileAtomic(file, `${current}${prefix}${GITIGNORE_ENTRY}\n`);
  }

  async load(): Promise<BoardSnapshot> {
    const { board, error: boardError } = await this.loadBoard();
    const dirs = await this.listTaskDirs();
    const cards = await Promise.all(dirs.map((dir) => this.loadCard(dir)));
    const ids = cards.flatMap((c) => (c.card ? [{ id: c.card.id, dir: c.dir }] : []));
    const duplicates = Object.fromEntries(findDuplicateIds(ids));
    const sharedDocExists = Object.fromEntries(
      await Promise.all(board.sharedDocs.map(async (d) => [d.id, await pathExists(path.join(this.root, d.path))] as const)),
    );
    return { board, boardError, cards, duplicates, sharedDocExists };
  }

  private async loadBoard(): Promise<{ board: BoardConfig; error?: CardLoadError }> {
    const fallback = defaultBoard();
    const text = await readTextIfExists(this.boardFile);
    if (text === undefined) return { board: fallback };
    if (hasConflictMarkers(text)) return { board: fallback, error: 'conflict' };
    try {
      const { board, migrated } = migrateBoard(JSON.parse(text));
      if (migrated) {
        await this.backup('board.json', text);
        await writeFileAtomic(this.boardFile, toJson(board));
      }
      return { board };
    } catch {
      return { board: fallback, error: 'invalid' };
    }
  }

  private async listTaskDirs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const withCard = await Promise.all(dirs.map(async (d) => ((await pathExists(this.cardFile(d))) ? d : undefined)));
      return withCard.filter((d): d is string => d !== undefined);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** 승인 대상 문서(intent.md·spec.md)의 지금 내용 해시 */
  async docsHash(dir: string): Promise<string> {
    const docs = await Promise.all(APPROVAL_DOCS.map((doc) => readTextIfExists(this.taskDocPath(dir, doc))));
    return createHash('sha256').update(approvalText(docs)).digest('hex');
  }

  async loadCard(dir: string): Promise<LoadedCard> {
    const items = parseChecklist((await readTextIfExists(this.taskDocPath(dir, 'plan'))) ?? '');
    const progress = itemsProgress(items);
    const tags = tagProgress(items);
    const hasCanvas = await pathExists(this.canvasPath(dir));
    const docsHash = await this.docsHash(dir);
    const text = await readTextIfExists(this.cardFile(dir));
    if (text === undefined) return { dir, error: 'invalid', errorDetail: 'card.json missing', progress, tags, hasCanvas, docsHash };
    if (hasConflictMarkers(text)) return { dir, error: 'conflict', progress, tags, hasCanvas, docsHash };
    try {
      const { card, migrated } = migrateCard(JSON.parse(text));
      if (migrated) {
        await this.backup(`${dir}-card.json`, text);
        await this.writeCard(dir, card);
      }
      return { dir, card, progress, tags, hasCanvas, docsHash };
    } catch (err) {
      return { dir, error: 'invalid', errorDetail: (err as Error).message, progress, tags, hasCanvas, docsHash };
    }
  }

  private async backup(name: string, content: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFileAtomic(path.join(this.localDir, 'backup', `${stamp}-${name}`), content);
  }

  async saveBoard(board: BoardConfig): Promise<void> {
    assertShareableBoard(board);
    await writeFileAtomic(this.boardFile, toJson(board));
  }

  private async writeCard(dir: string, card: Card): Promise<void> {
    assertShareableCard(card);
    await writeFileAtomic(this.cardFile(dir), toJson(card));
  }

  /** 카드 폴더 이름은 카드 ID와 같다. */
  async saveCard(card: Card): Promise<void> {
    await this.writeCard(card.id, card);
  }

  async usedIds(): Promise<string[]> {
    const dirs = await this.listAllTaskFolders();
    let tombstones: string[] = [];
    try {
      tombstones = await fs.readdir(this.tombstoneDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return [...dirs, ...tombstones].filter(isTaskId);
  }

  private async listAllTaskFolders(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.tasksDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async createCard(input: NewCardInput, order: number, now = new Date().toISOString()): Promise<Card> {
    const id = nextTaskId(await this.usedIds());
    const card: Card = {
      schemaVersion: CARD_SCHEMA_VERSION,
      id,
      title: input.title,
      description: input.description,
      status: 'todo',
      statusVersion: 0,
      order,
      agents: {},
      relatedDocs: input.relatedDocs ?? [],
      createdAt: now,
      updatedAt: now,
    };
    // card.json을 먼저 써서, 저장이 거부되면 작업 문서만 남은 폴더가 생기지 않게 한다.
    await this.saveCard(card);
    for (const doc of TASK_DOCS) {
      const file = this.taskDocPath(id, doc);
      if (!(await pathExists(file))) await writeFileAtomic(file, taskDocTemplate(doc, id, input.title, this.locale));
    }
    return card;
  }

  /** C-5, C-6: 삭제한 ID는 tombstone으로 남긴다. deleteDocs가 false면 작업 문서는 남겨 둔다. */
  async deleteCard(dir: string, deleteDocs: boolean): Promise<void> {
    const loaded = await this.loadCard(dir);
    const id = loaded.card?.id ?? dir;
    await fs.mkdir(this.tombstoneDir, { recursive: true });
    if (isTaskId(id)) await writeFileAtomic(path.join(this.tombstoneDir, id), '');
    if (isTaskId(dir) && dir !== id) await writeFileAtomic(path.join(this.tombstoneDir, dir), '');
    if (deleteDocs) await fs.rm(this.taskDir(dir), { recursive: true, force: true });
    else await fs.rm(this.cardFile(dir), { force: true });
  }

  /** S-6: 카드를 새 ID로 옮긴다. 기존 ID는 tombstone으로 남기지 않는다(다른 카드가 쓰고 있으므로). */
  async renumberCard(dir: string): Promise<Card> {
    const loaded = await this.loadCard(dir);
    if (!loaded.card) throw new Error(`card ${dir} cannot be loaded`);
    const id = nextTaskId(await this.usedIds());
    const target = this.taskDir(id);
    await fs.rename(this.taskDir(dir), target);
    const card: Card = { ...loaded.card, id, updatedAt: new Date().toISOString() };
    await this.saveCard(card);
    return card;
  }

  async readTaskDoc(dir: string, doc: TaskDoc): Promise<string | undefined> {
    return readTextIfExists(this.taskDocPath(dir, doc));
  }

  async writeTaskDoc(dir: string, doc: TaskDoc, content: string): Promise<void> {
    await writeFileAtomic(this.taskDocPath(dir, doc), content);
  }

  async addSharedDoc(board: BoardConfig, doc: Omit<SharedDoc, 'id'>): Promise<BoardConfig> {
    const used = new Set(board.sharedDocs.map((d) => d.id));
    let n = board.sharedDocs.length + 1;
    while (used.has(`doc-${n}`)) n += 1;
    const next = { ...board, sharedDocs: [...board.sharedDocs, { ...doc, id: `doc-${n}` }] };
    await this.saveBoard(next);
    return next;
  }

  relativeToRoot(absolute: string): string | undefined {
    const rel = path.relative(this.root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  }
}
