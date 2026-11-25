// What Settings' Desktop App card says under Open at Login, the desktop companion and the terminal
// command, by the state the desktop app reports for each, and what a failed change's toast says.
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import type {
  CommandChange,
  CommandState,
  CompanionState,
  LoginItemState,
  Unavailable,
} from "@/lib/desktop";

/** Why this copy of the app can't offer an option, said under either row. */
const UNAVAILABLE_NOTES: Readonly<Record<Unavailable, MessageDescriptor>> = {
  background: msg`Background mode leaves this computer as it is.`,
  unpackaged: msg`Available in the installed app only.`,
  "outside-applications": msg`Move LAPLACE Eidolon to the Applications folder to use this.`,
  "not-installed": msg`Install LAPLACE Eidolon with its installer to use this.`,
};

/** A row's line under its description; a warning asks the owner to do something. */
export interface Note {
  readonly text: MessageDescriptor;
  readonly tone: "muted" | "warning";
}

/** The line under Open at Login, or null when its switch says it all. */
export function loginItemNote(item: LoginItemState): Note | null {
  switch (item.state) {
    case "unavailable":
      return { text: UNAVAILABLE_NOTES[item.reason], tone: "muted" };
    case "needs-approval":
      return {
        text: msg`Waiting for your OK in System Settings: turn LAPLACE Eidolon on under General → Login Items.`,
        tone: "warning",
      };
    case "on":
    case "off":
      return null;
  }
}

/** The lines under Desktop Companion: background mode, and her picture while she has no model. */
export function companionNotes(state: CompanionState, hasModel: boolean): Note[] {
  const notes: Note[] = [];
  if (state.background) notes.push({ text: msg`Background mode never shows her.`, tone: "muted" });
  if (!hasModel) {
    notes.push({
      text: msg`She shows as her picture until she has an active character model.`,
      tone: "muted",
    });
  }
  return notes;
}

/**
 * The line under the terminal command: where Install puts it or where it is, or why it can't be
 * installed. `path` is a link on macOS, and on Windows a folder on the owner's PATH.
 */
export function commandNote(command: CommandState, platform: string): Note {
  const windows = platform === "win32";
  switch (command.state) {
    case "unavailable":
      return { text: UNAVAILABLE_NOTES[command.reason], tone: "muted" };
    case "absent": {
      const { path } = command;
      return {
        text: windows
          ? msg`Install adds ${ph({ path })} to your PATH.`
          : msg`Install puts it at ${ph({ path })}, and may ask for your password.`,
        tone: "muted",
      };
    }
    case "installed": {
      const { path } = command;
      return {
        text: windows
          ? msg`Added to your PATH: ${ph({ path })}. Open a new terminal to use it.`
          : msg`Installed at ${ph({ path })}.`,
        tone: "muted",
      };
    }
    case "taken": {
      const { path } = command;
      return { text: msg`Another eidolon is at ${ph({ path })}.`, tone: "warning" };
    }
  }
}

/**
 * A failed install's or removal's toast: what didn't happen, then where the app's log says why. Null
 * when it went through, or when the owner cancelled macOS's password prompt themselves.
 */
export function changeFailed(
  change: CommandChange,
  action: "install" | "remove",
  platform: string,
): { readonly title: MessageDescriptor; readonly detail: MessageDescriptor } | null {
  if (change.error !== "failed") return null;
  return {
    title:
      action === "install"
        ? msg`Couldn't install the eidolon command.`
        : msg`Couldn't remove the eidolon command.`,
    detail:
      platform === "darwin"
        ? msg`Show Logs in the Help menu has the details.`
        : msg`Show Logs in the tray icon's menu has the details.`,
  };
}
