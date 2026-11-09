// 단위 테스트용 vscode 모듈 대체. 대화상자는 stub.answers에 넣은 값을 순서대로 돌려준다.

export const stub = {
  answers: [] as unknown[],
  messages: [] as { level: string; text: string }[],
  /** 등록돼 있다고 볼 명령 */
  commands: new Set<string>(),
  executed: [] as unknown[][],
  terminals: [] as { name: string; cwd: string; text: string[] }[],
};

function answer(level: string) {
  return async (text: string, ...items: unknown[]) => {
    stub.messages.push({ level, text });
    if (stub.answers.length) return stub.answers.shift();
    const choices = items.filter((i) => typeof i === 'string');
    return level === 'warning' ? choices[0] : undefined;
  };
}

export const window = {
  showWarningMessage: answer('warning'),
  showErrorMessage: answer('error'),
  showInformationMessage: answer('info'),
  showQuickPick: async (items: unknown[]) => (stub.answers.length ? stub.answers.shift() : items[0]),
  showInputBox: async (opts?: { value?: string }) => (stub.answers.length ? stub.answers.shift() : opts?.value),
  showTextDocument: async () => undefined,
  createTerminal: (opts: { name: string; cwd: string }) => {
    const terminal = { ...opts, text: [] as string[] };
    stub.terminals.push(terminal);
    return { show: () => undefined, sendText: (text: string) => void terminal.text.push(text) };
  },
};

export const commands = {
  getCommands: async () => [...stub.commands],
  executeCommand: async (...args: unknown[]) => void stub.executed.push(args),
};

export const extensions = { getExtension: (id: string) => (stub.commands.has(`extension:${id}`) ? {} : undefined) };

export const Uri = {
  file: (p: string) => ({ fsPath: p }),
  from: (c: { scheme: string; authority?: string; path: string }) => ({ ...c, toString: () => `${c.scheme}://${c.authority ?? ''}${c.path}` }),
};

export class Disposable {
  dispose(): void {}
}
