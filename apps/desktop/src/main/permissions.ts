// The page's permissions, on the session before its first load: with no handlers,
// Electron grants every request and passes every check. policy.ts decides; this asks macOS for the
// microphone and says where to turn it on once it's been denied.
import { dialog, type Session, systemPreferences, type WebContents } from "electron";
import { mainLog } from "./log.ts";
import { checkAllows, microphoneStep, requestAction } from "./policy.ts";
import type { Strings } from "./strings.ts";

export interface PermissionContext {
  /** Whether `contents` is the app window's. */
  readonly isWindow: (contents: WebContents | null) => boolean;
  readonly strings: () => Strings;
}

async function microphone({ text, label }: Strings): Promise<boolean> {
  const step = microphoneStep(
    process.platform,
    process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "",
  );
  if (step === "grant") return true;
  if (step === "ask") return systemPreferences.askForMediaAccess("microphone");
  // No owner window: the box stands on its own, whatever the page does meanwhile.
  await dialog.showMessageBox({
    type: "warning",
    title: "Eidolon",
    message: text.microphoneTitle,
    detail: text.microphone,
    buttons: [label.ok],
    noLink: true,
  });
  return false;
}

export function guardPermissions(session: Session, context: PermissionContext): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const window = context.isWindow(contents);
    const action = requestAction(permission, {
      window,
      mainFrame: details.isMainFrame,
      mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
      securityOrigin: "securityOrigin" in details ? details.securityOrigin : undefined,
      frameOrigin: window ? contents.mainFrame.origin : null,
    });
    if (action === "grant") {
      callback(true);
      return;
    }
    if (action === "deny") {
      mainLog.info(`Eidolon: denied the page ${permission}`);
      callback(false);
      return;
    }
    microphone(context.strings()).then(callback, (error: unknown) => {
      mainLog.warn(`Eidolon: macOS's microphone access failed: ${String(error)}`);
      callback(false);
    });
  });
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    checkAllows(permission, requestingOrigin, {
      window: context.isWindow(contents),
      mediaType: details.mediaType,
    }),
  );
}
