// Who sent an IPC message: which of the app's windows, by its webContents, and whether from that
// window's main frame. Main names each window's webContents as it makes them.
import type { IpcMainEvent, WebContents } from "electron";
import type { IpcSender, WindowKind } from "../shared/bridge.ts";

type Contents = () => Pick<WebContents, "mainFrame"> | null;

const windows = new Map<WindowKind, Contents>();

/** Names `kind`'s webContents, as main has it now; null while there is none. */
export function senderWindow(kind: WindowKind, contents: Contents): void {
  windows.set(kind, contents);
}

/** Who sent `event`, a message or an invoke, for the bridges' sender rule (bridge.ts's accepts). */
export function ipcSender(event: Pick<IpcMainEvent, "sender" | "senderFrame">): IpcSender {
  const origin = event.senderFrame?.origin ?? null;
  for (const [kind, contents] of windows) {
    const own = contents();
    if (own !== null && event.sender === own) {
      return { window: kind, mainFrame: event.senderFrame === own.mainFrame, origin };
    }
  }
  return { window: null, mainFrame: false, origin };
}
