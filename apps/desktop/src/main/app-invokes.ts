// The pages' invokes on main: the app page's (the folder dialog, the system options and the desktop
// companion), each answering only the main window's main frame at eidolon-app://app, and the
// companion's, each answering only her window's. Each takes only the argument its action does.
// Electron-free: chrome.ts and companion-window.ts hand each to ipcMain.handle.
import {
  accepts,
  BRIDGE,
  type CommandAction,
  type CommandChange,
  type CommandState,
  type CompanionChange,
  type CompanionMenuState,
  type CompanionPick,
  type CompanionShape,
  type CompanionState,
  companionMenuStateOf,
  companionShapeOf,
  type IpcSender,
  isCommandAction,
  isCompanionChange,
  isLocalNetworkTestRequest,
  isModelRef,
  isPermissionId,
  type LocalNetworkTestRequest,
  type LocalNetworkTestResult,
  type LoginItemState,
  type ModelRef,
  type PageChannel,
  type PermissionId,
  type PermissionRequestResult,
  type PermissionsState,
  type UpdateCheckOutcome,
  type WindowSize,
} from "../shared/bridge.ts";

export interface AppInvokes {
  /** The native folder dialog's pick, or null when cancelled. */
  readonly chooseFolder: () => Promise<string | null>;
  readonly loginItem: () => LoginItemState;
  readonly setLoginItem: (on: boolean) => LoginItemState;
  readonly terminalCommand: () => Promise<CommandState>;
  readonly setTerminalCommand: (action: CommandAction) => Promise<CommandChange>;
  readonly companion: () => CompanionState;
  readonly setCompanion: (change: CompanionChange) => CompanionState;
  readonly popOut: () => CompanionState;
  readonly resetCompanionPlace: () => CompanionState;
  /** Whether the model's file was there to show. */
  readonly revealModel: (model: ModelRef) => boolean;
  readonly updateCheck: () => Promise<UpdateCheckOutcome>;
  readonly updateDownload: () => void;
  readonly updateInstall: () => void;
  readonly updateSkip: () => void;
  readonly permissions: () => Promise<PermissionsState>;
  readonly requestPermission: (id: PermissionId) => Promise<PermissionRequestResult>;
  readonly openPermissionSettings: (id: PermissionId) => Promise<boolean>;
  readonly testLocalNetwork: (target: LocalNetworkTestRequest) => Promise<LocalNetworkTestResult>;
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
    guarded(BRIDGE.companion, () => actions.companion()),
    guarded(BRIDGE.setCompanion, (change) => {
      if (!isCompanionChange(change)) {
        throw new Error("the desktop companion takes on or showAtLogin, each true or false");
      }
      return actions.setCompanion(change);
    }),
    guarded(BRIDGE.popOut, () => actions.popOut()),
    guarded(BRIDGE.resetCompanionPlace, () => actions.resetCompanionPlace()),
    guarded(BRIDGE.revealModel, (model) => {
      if (!isModelRef(model)) throw new Error("a model is a persona's id and a model's id");
      return actions.revealModel({ persona: model.persona, model: model.model });
    }),
    guarded(BRIDGE.updateCheck, () => actions.updateCheck()),
    guarded(BRIDGE.updateDownload, () => actions.updateDownload()),
    guarded(BRIDGE.updateInstall, () => actions.updateInstall()),
    guarded(BRIDGE.updateSkip, () => actions.updateSkip()),
    guarded(BRIDGE.permissions, () => actions.permissions()),
    guarded(BRIDGE.requestPermission, (id) => {
      if (!isPermissionId(id)) throw new Error("a permission must be a known permission id");
      return actions.requestPermission(id);
    }),
    guarded(BRIDGE.openPermissionSettings, (id) => {
      if (!isPermissionId(id)) throw new Error("a permission must be a known permission id");
      return actions.openPermissionSettings(id);
    }),
    guarded(BRIDGE.testLocalNetwork, (target) => {
      if (!isLocalNetworkTestRequest(target)) {
        throw new Error("a local network test takes a host and port");
      }
      return actions.testLocalNetwork({ host: target.host, port: target.port });
    }),
  ];
}

export interface CompanionInvokes {
  readonly shape: (shape: CompanionShape) => WindowSize;
  readonly menu: (state: CompanionMenuState) => Promise<CompanionPick | null>;
}

/** Her page's invokes: each refuses another sender before it reads the argument, then one that doesn't read. */
export function companionInvokes(
  actions: CompanionInvokes,
): readonly (readonly [PageChannel, InvokeAnswer])[] {
  return [
    guarded(BRIDGE.companionShape, (value) => {
      const shape = companionShapeOf(value);
      if (shape === null) throw new Error("her shape is her picture, or her model's aspect");
      return actions.shape(shape);
    }),
    guarded(BRIDGE.companionMenu, (value) => {
      const state = companionMenuStateOf(value);
      if (state === null) throw new Error("her menu takes the call's state and her models");
      return actions.menu(state);
    }),
  ];
}
