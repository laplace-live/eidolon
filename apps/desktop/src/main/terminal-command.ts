// The `eidolon` command for terminals, which the owner installs or removes from Settings alone: on
// macOS a link in /usr/local/bin to the launcher in the app's resources, on Windows that launcher's
// folder on the user's PATH. Electron-free: index.ts hands it the app's facts.
import type { CommandChange, CommandState, Unavailable } from "../shared/bridge.ts";
import type { Strings } from "./strings.ts";

export interface CommandHost {
  readonly platform: NodeJS.Platform;
  /** process.resourcesPath of the packaged app. */
  readonly resourcesPath: string;
  /** optionsUnavailable(...) for this copy. */
  readonly unavailable: Unavailable | null;
  /** The shell's strings now, for macOS's password prompt. */
  readonly strings: () => Strings;
  readonly log: { info(message: string): void; warn(message: string): void };
}

/** Where the command stands. Not built yet: every copy reads as one that can't offer it. */
export async function commandState(host: CommandHost): Promise<CommandState> {
  return { state: "unavailable", reason: host.unavailable ?? "unpackaged" };
}

/** Installs or removes the command. Not built yet: nothing changes. */
export async function changeCommand(
  host: CommandHost,
  _action: "install" | "remove",
): Promise<CommandChange> {
  return { command: await commandState(host), error: "failed" };
}
