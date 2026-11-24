// The app page's invokes on main, the folder dialog and the system options: each answers only the
// window's main frame at eidolon-app://app, and takes only the argument its action does.
// Electron-free: chrome.ts hands each to ipcMain.handle.
import {
  accepts,
  BRIDGE,
  type CommandAction,
  type CommandChange,
  type CommandState,
  type IpcSender,
  isCommandAction,
  type LoginItemState,
  type PageChannel,
} from "../shared/bridge.ts";

export interface AppInvokes {
  /** The native folder dialog's pick, or null when cancelled. */
  readonly chooseFolder: () => Promise<string | null>;
  readonly loginItem: () => LoginItemState;
  readonly setLoginItem: (on: boolean) => LoginItemState;
  readonly terminalCommand: () => Promise<CommandState>;
  readonly setTerminalCommand: (action: CommandAction) => Promise<CommandChange>;
}

/** An invoke's answer to who sent it and its argument; throws for another sender or argument. */
export type InvokeAnswer = (sender: IpcSender, argument: unknown) => unknown;

function guarded(
  channel: PageChannel,
  respond: (argument: unknown) => unknown,
): readonly [PageChannel, InvokeAnswer] {
  return [
    channel,
    (sender, argument) => {
      if (!accepts(channel, sender)) throw new Error("refused");
      return respond(argument);
    },
  ];
}

/** Each invoke's channel and its answer, which refuses a sender before it reads the argument. */
export function appInvokes(actions: AppInvokes): readonly (readonly [PageChannel, InvokeAnswer])[] {
  return [
    guarded(BRIDGE.chooseFolder, () => actions.chooseFolder()),
    guarded(BRIDGE.loginItem, () => actions.loginItem()),
    guarded(BRIDGE.setLoginItem, (on) => {
      if (typeof on !== "boolean") throw new Error("Open at Login takes true or false");
      return actions.setLoginItem(on);
    }),
    guarded(BRIDGE.terminalCommand, () => actions.terminalCommand()),
    guarded(BRIDGE.setTerminalCommand, (action) => {
      if (!isCommandAction(action)) throw new Error("the terminal command takes install or remove");
      return actions.setTerminalCommand(action);
    }),
  ];
}
