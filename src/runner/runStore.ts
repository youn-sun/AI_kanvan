// `.agent-board/local/`의 실행 기록. Git으로 공유하지 않는다 (spec 1.1).

import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { EMPTY_RUNS, replay, type AgentEvent, type RunsState } from '../core/runs';
import type { Role, ToolId } from '../core/types';
import { outboxFile } from './outbox';
import { pathExists, readTextIfExists, toJson, writeFileAtomic } from '../storage/fsutil';

/** 카드를 찾아 회차로 다시 보낸 이벤트의 ID 꼬리 */
export const LINKED_SUFFIX = ':linked';

export function isLinkedEvent(event: AgentEvent): boolean {
  return event.eventId.endsWith(LINKED_SUFFIX);
}

/** 0.0.1의 반복 연결 버그로 `:linked`가 겹겹이 붙은 ID. 실제 이벤트가 아니므로 읽을 때 버린다. */
const LOOPED = `${LINKED_SUFFIX}${LINKED_SUFFIX}`;
/** runs.json에서 seenEventIds 배열의 한 항목인 줄. 요약 등 키가 있는 줄은 해당하지 않는다. */
const LOOPED_ID_LINE = /^\s*"[^"]*:linked:linked[^"]*",?$/;

/** 파일을 한 줄씩 읽는다. 버그로 커진 파일은 문자열 하나에 담을 수 없을 만큼 클 수 있다. */
async function* readLines(file: string): AsyncGenerator<string> {
  if (!(await pathExists(file))) return;
  const lines = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) yield line;
}

export interface SessionBinding {
  tool: ToolId;
  sessionId: string;
}

/** 카드 ID → 역할 → 현재 세션 (E-5) */
export type SessionBindings = Record<string, Partial<Record<Role, SessionBinding>>>;

export interface UnlinkedSession {
  tool: ToolId;
  sessionId: string;
  cwd: string;
  /** 첫 요청 */
  prompt?: string;
  /** 숨긴 세션. 다시 목록에 넣지 않으려고 남긴다. */
  dismissed?: boolean;
}

export interface InboxItem {
  file: string;
  tool: ToolId;
  receivedAt: string;
  runId?: string;
  cardId?: string;
  /** 보드가 판단용으로 띄운 세션 */
  internal?: boolean;
  input: unknown;
}

export class RunStore {
  constructor(readonly localDir: string) {}

  private get runsFile(): string {
    return path.join(this.localDir, 'runs.json');
  }
  private get eventsFile(): string {
    return path.join(this.localDir, 'events.jsonl');
  }
  private get sessionsFile(): string {
    return path.join(this.localDir, 'sessions.json');
  }
  private get unlinkedFile(): string {
    return path.join(this.localDir, 'unlinked.json');
  }
  get outboxDir(): string {
    return path.join(this.localDir, 'outbox');
  }

  /** 다음 Hook 실행 때 세션에 전달할 알림을 쌓는다 (E-12). */
  async pushOutbox(tool: ToolId, sessionId: string, message: string): Promise<void> {
    const file = outboxFile(this.outboxDir, tool, sessionId);
    const text = await readTextIfExists(file);
    let messages: string[] = [];
    try {
      messages = text ? (JSON.parse(text) as { messages: string[] }).messages : [];
    } catch {
      messages = [];
    }
    await writeFileAtomic(file, toJson({ messages: [...messages, message] }));
  }

  get inboxDir(): string {
    return path.join(this.localDir, 'inbox');
  }
  runDir(cardId: string): string {
    return path.join(this.localDir, 'runs', cardId);
  }

  /**
   * H-5: 스냅샷을 읽고 이벤트 로그를 다시 적용한다. 이미 처리한 이벤트는 eventId로 걸러진다.
   * 반복 연결 버그로 쌓인 항목이 있으면 버리고 두 파일을 다시 쓴다.
   */
  async loadRuns(): Promise<RunsState> {
    let looped = false;
    const kept: string[] = [];
    for await (const line of readLines(this.runsFile)) {
      // toJson은 seenEventIds를 한 줄에 하나씩 쓴다. 실행 기록 필드에는 이벤트 ID가 없다.
      if (LOOPED_ID_LINE.test(line)) looped = true;
      else kept.push(line);
    }
    let state: RunsState = EMPTY_RUNS;
    if (kept.length > 0) {
      try {
        // 지운 줄이 배열의 마지막이었으면 앞 줄의 쉼표가 남는다.
        state = JSON.parse(kept.join('\n').replace(/,(\s*\])/g, '$1')) as RunsState;
      } catch {
        state = EMPTY_RUNS;
      }
    }
    const { events, dropped } = await this.readEvents();
    const next = replay(state, events);
    if (dropped > 0) await this.rewriteEvents(events);
    if (looped || dropped > 0) await this.saveRuns(next);
    return next;
  }

  async loadEvents(): Promise<AgentEvent[]> {
    return (await this.readEvents()).events;
  }

  private async readEvents(): Promise<{ events: AgentEvent[]; dropped: number }> {
    const events: AgentEvent[] = [];
    let dropped = 0;
    for await (const line of readLines(this.eventsFile)) {
      if (!line) continue;
      let event: AgentEvent;
      try {
        event = JSON.parse(line) as AgentEvent;
      } catch {
        continue; // 쓰는 도중 끊긴 줄
      }
      if (event.eventId.includes(LOOPED)) dropped += 1;
      else events.push(event);
    }
    return { events, dropped };
  }

  private async rewriteEvents(events: AgentEvent[]): Promise<void> {
    await writeFileAtomic(this.eventsFile, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }

  async saveRuns(state: RunsState): Promise<void> {
    await writeFileAtomic(this.runsFile, toJson(state));
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    await fs.mkdir(this.localDir, { recursive: true });
    await fs.appendFile(this.eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async loadSessions(): Promise<SessionBindings> {
    const text = await readTextIfExists(this.sessionsFile);
    return text ? (JSON.parse(text) as SessionBindings) : {};
  }

  async saveSessions(bindings: SessionBindings): Promise<void> {
    await writeFileAtomic(this.sessionsFile, toJson(bindings));
  }

  /** 카드 ID → 사용자가 카드를 마지막으로 연 시각. 끝난 실행을 아직 안 봤는지 가린다. */
  async loadSeen(): Promise<Record<string, string>> {
    const text = await readTextIfExists(path.join(this.localDir, 'seen.json'));
    return text ? (JSON.parse(text) as Record<string, string>) : {};
  }

  async saveSeen(seen: Record<string, string>): Promise<void> {
    await writeFileAtomic(path.join(this.localDir, 'seen.json'), toJson(seen));
  }

  async loadUnlinked(): Promise<UnlinkedSession[]> {
    const text = await readTextIfExists(this.unlinkedFile);
    return text ? (JSON.parse(text) as UnlinkedSession[]) : [];
  }

  async saveUnlinked(list: UnlinkedSession[]): Promise<void> {
    await writeFileAtomic(this.unlinkedFile, toJson(list));
  }

  /** Hook 스크립트가 남긴 파일을 받은 순서대로 읽는다. */
  async readInbox(): Promise<InboxItem[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.inboxDir)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const items: InboxItem[] = [];
    for (const name of names) {
      const file = path.join(this.inboxDir, name);
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Omit<InboxItem, 'file'>;
        items.push({ ...raw, file });
      } catch {
        await fs.rm(file, { force: true });
      }
    }
    return items;
  }

  async removeInbox(item: InboxItem): Promise<void> {
    await fs.rm(item.file, { force: true });
  }
}
