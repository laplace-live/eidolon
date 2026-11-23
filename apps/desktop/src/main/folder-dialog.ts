// The native folder dialog the Assistant's folders take a pick from: one at a time, opening at the
// home folder. The page adds the pick to its draft; saving the setting decides, and FolderPolicy
// after it. Electron-free: index.ts opens it through native.ts.
import type { OpenDialogOptions } from "electron";
import type { Strings } from "./strings.ts";

/** The dialog's options, at `home`: Electron would open it in Downloads. */
export function folderDialogOptions({ label, text }: Strings, home: string): OpenDialogOptions {
  return {
    properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
    defaultPath: home,
    title: label.chooseFolderTitle,
    message: text.chooseFolder,
    buttonLabel: label.chooseFolderButton,
  };
}

/** `start` as one call at a time: a call while one is pending joins it, and gets its answer. */
export function joinPending<T>(start: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending !== null) return pending;
    const started = start().finally(() => {
      if (pending === started) pending = null;
    });
    pending = started;
    return started;
  };
}
