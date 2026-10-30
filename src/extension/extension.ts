import * as vscode from 'vscode';
import type { ToolId } from '../core/types';
import { RunService, type MatcherTool } from '../runner/runService';
import { RunStore } from '../runner/runStore';
import { BoardRepository } from '../storage/repository';
import { toLocale, translate } from '../shared/i18n';
import { BoardController } from './boardController';
import { CanvasController } from './canvasController';

let controller: BoardController | undefined;

/** 통합 테스트에서 쓰는 API를 돌려준다. */
export function activate(context: vscode.ExtensionContext): { controller?: BoardController; runService?: RunService } {
  const locale = toLocale(vscode.env.language);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let runService: RunService | undefined;
  let ready: Promise<void> = Promise.resolve();

  const requireController = (): BoardController | undefined => {
    if (!controller) void vscode.window.showWarningMessage(translate(locale, 'board.noWorkspace'));
    return controller;
  };

  if (root) {
    const repo = new BoardRepository(root, locale);
    controller = new BoardController(context, repo, locale);
    const toolPaths = () => vscode.workspace.getConfiguration('agentBoard').get<Partial<Record<ToolId, string>>>('toolPaths') ?? {};
    const config = () => vscode.workspace.getConfiguration('agentBoard');
    runService = new RunService(controller, new RunStore(repo.localDir), context.asAbsolutePath('dist/hook.js'), toolPaths, {
      autoCreate: () => config().get<boolean>('autoCreateCards', true),
      matcherTool: () => config().get<MatcherTool>('matcherTool', 'auto'),
      canvasGuide: context.asAbsolutePath('docs/canvas-guide.md'),
    });
    controller.runs = runService;
    controller.canvas = new CanvasController(controller, runService, context.asAbsolutePath('docs/canvas-guide.md'));
    context.subscriptions.push(controller, runService);
    // V-1: 활성화하면 실행 기록과 실제 프로세스를 대조한다.
    ready = controller
      .reload()
      .then(() => runService!.init())
      .then(() => controller!.reload())
      .catch((err) => void vscode.window.showErrorMessage(`Agent Board: ${(err as Error).message}`));
    // 알림에 답할 때까지 기다리면 명령이 멈추므로 초기화와 분리한다.
    void ready.then(() => offerHooks(repo, runService!));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBoard.open', async () => {
      const c = requireController();
      if (!c) return;
      c.open();
      await ready;
      await c.reload();
    }),
    vscode.commands.registerCommand('agentBoard.createCard', async () => {
      const c = requireController();
      if (!c) return;
      const title = await vscode.window.showInputBox({ prompt: translate(locale, 'msg.newCardTitle') });
      if (!title) return;
      await ready;
      await c.createCard(title);
      c.open();
      await c.reload();
    }),
    vscode.commands.registerCommand('agentBoard.renumberCard', async () => {
      const c = requireController();
      if (!c) return;
      await c.reload();
      const pick = await vscode.window.showQuickPick(c.loadedCards.map((v) => ({ label: v.dir, description: v.card?.title })));
      if (pick) await c.handle({ type: 'renumberCard', dir: pick.label });
    }),
    vscode.commands.registerCommand('agentBoard.openSettings', async () => {
      const c = requireController();
      if (!c) return;
      c.open();
      await ready;
      await c.reload();
      c.post({ type: 'showSettings' });
    }),
    vscode.commands.registerCommand('agentBoard.installHooks', async () => {
      if (!requireController() || !runService) return;
      await ready;
      await runService.installHooksCommand();
    }),
    vscode.commands.registerCommand('agentBoard.detectTools', async () => {
      if (!requireController() || !runService) return;
      await runService.detectTools();
      await controller!.reload();
    }),
    // 에이전트·다른 확장이 세션을 카드에 연결한다. 방금 만든 카드도 찾도록 먼저 다시 읽는다.
    vscode.commands.registerCommand('agentBoard.linkSession', async (cardId?: string, role?: string, tool?: string, sessionId?: string) => {
      if (!requireController() || !runService) return false;
      await ready;
      await controller!.reload();
      return runService.connectSession(cardId, role, tool, sessionId);
    }),
    // 터미널의 에이전트는 명령을 직접 부를 수 없어서 URI로 받는다.
    // 예: code --open-url "vscode://agent-board.agent-board/linkSession?card=TASK-1&role=implementer&tool=claude&session=<id>"
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        if (uri.path !== '/linkSession') return;
        const q = new URLSearchParams(uri.query);
        const get = (k: string) => q.get(k) ?? undefined;
        void vscode.commands.executeCommand('agentBoard.linkSession', get('card'), get('role'), get('tool'), get('session'));
      },
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('agentBoard.toolPaths') && runService) await runService.detectTools();
      // 설정 화면의 "이 기기" 값이 바뀌면 다시 그린다.
      if (e.affectsConfiguration('agentBoard')) await controller?.reload();
    }),
  );
  return { controller, runService };
}

/** 보드가 있는데 Hook이 없으면 설치를 권한다. 없으면 채팅 요청이 카드로 반영되지 않는다 (E-9). */
async function offerHooks(repo: BoardRepository, runService: RunService): Promise<void> {
  const config = vscode.workspace.getConfiguration('agentBoard');
  if (!config.get<boolean>('autoCreateCards', true) || runService.hooksInstalled() || !(await repo.isInitialized())) return;
  const locale = toLocale(vscode.env.language);
  const install = translate(locale, 'board.installHooks');
  const choice = await vscode.window.showInformationMessage(translate(locale, 'msg.hooksNeeded'), install, translate(locale, 'msg.later'));
  if (choice === install) {
    await runService.installHooksCommand();
    await controller?.reload();
  }
}

export function deactivate(): void {
  controller = undefined;
}
