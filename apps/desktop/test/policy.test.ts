// What the window may do: where links and navigations go, which permissions the page gets, and the
// packaged app's refusal of the switches that open CDP.
import { describe, expect, test } from "vitest";
import {
  checkAllows,
  DEBUGGING_SWITCHES,
  isAppOrigin,
  leftTheApp,
  loggedText,
  loggedUrl,
  mayRedirect,
  microphoneStep,
  navigationAction,
  openAction,
  type PermissionAsker,
  refusesDebugging,
  requestAction,
} from "../src/main/policy.ts";

describe("isAppOrigin", () => {
  test("is eidolon-app://app as Chromium serializes an origin, with or without the slash", () => {
    expect(isAppOrigin("eidolon-app://app")).toBe(true);
    expect(isAppOrigin("eidolon-app://app/")).toBe(true);
  });

  test("and nothing else: another host, a path, an opaque origin, a URL with more in it", () => {
    for (const origin of [
      "null",
      "",
      null,
      undefined,
      "eidolon-app://shell",
      "eidolon-app://other",
      "eidolon-app://app/chats",
      "eidolon-app://app/?x=1",
      "eidolon-app://app/#x",
      "eidolon-app://user@app",
      "eidolon-app://app:1",
      "http://app",
      "https://app/",
      "http://127.0.0.1:7860",
    ]) {
      expect([origin, isAppOrigin(origin)]).toEqual([origin, false]);
    }
  });
});

describe("links the page opens in a new window", () => {
  test("go to the default browser for the web, and save as a download for the app's own files", () => {
    expect(openAction("https://example.com/docs")).toBe("browser");
    expect(openAction("http://localhost:3000/")).toBe("browser");
    expect(openAction("eidolon-app://app/api/local/chats/c1/files/a.png")).toBe("download");
  });

  test("and go nowhere otherwise: file:, other apps' schemes, the shell, javascript:", () => {
    for (const url of [
      "file:///etc/hosts",
      "eidolon-app://shell/failed",
      "eidolon-app://other/x",
      "vscode://file/x",
      "javascript:alert(1)",
      "data:text/html,<p>x",
      "about:blank",
      "not a url",
    ]) {
      expect([url, openAction(url)]).toEqual([url, "deny"]);
    }
  });
});

describe("navigations", () => {
  test("stay on the app's address, and a link out to the web opens in the browser instead", () => {
    expect(navigationAction("eidolon-app://app/settings")).toBe("allow");
    expect(navigationAction("eidolon-app://app/")).toBe("allow");
    expect(navigationAction("https://example.com/")).toBe("browser");
    expect(navigationAction("http://127.0.0.1:7860/")).toBe("browser");
  });

  test("anywhere else is cancelled outright, the shell's pages included", () => {
    for (const url of [
      "eidolon-app://shell/loading",
      "eidolon-app://other/",
      "file:///Users/x",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "data:text/html,x",
    ]) {
      expect([url, navigationAction(url)]).toEqual([url, "deny"]);
    }
  });

  test("a redirect keeps to the app's address and never opens anything", () => {
    expect(mayRedirect("eidolon-app://app/chats")).toBe(true);
    for (const url of ["https://example.com/", "eidolon-app://shell/failed", "file:///x"]) {
      expect([url, mayRedirect(url)]).toEqual([url, false]);
    }
  });

  test("a page committed off eidolon-app://, which no event let main cancel, has left the app", () => {
    for (const url of [
      "about:blank",
      "about:blank#x",
      "about:blank?y",
      "about:srcdoc",
      "data:text/html,x",
      "https://example.com/",
      "eidolon-app://other/",
    ]) {
      expect([url, leftTheApp(url)]).toEqual([url, true]);
    }
    for (const url of ["eidolon-app://app/chats/c1", "eidolon-app://shell/loading"]) {
      expect([url, leftTheApp(url)]).toEqual([url, false]);
    }
  });
});

test("main.log names an address without its user name, password, query or fragment", () => {
  expect(loggedUrl("eidolon-app://app/chats/c1?tab=files#end")).toBe("eidolon-app://app/chats/c1");
  expect(loggedUrl("eidolon-app://shell/loading")).toBe("eidolon-app://shell/loading");
  expect(loggedUrl("about:blank#x")).toBe("about:blank");
  expect(loggedUrl("about:blank?y")).toBe("about:blank");
  expect(loggedUrl("https://owner:hunter2@example.com/a?b#c")).toBe("https://example.com/a");
  expect(loggedUrl("https://owner@example.com/")).toBe("https://example.com/");
  expect(loggedUrl("eidolon-app://owner:hunter2@app/chats")).toBe("eidolon-app://app/chats");
  expect(loggedUrl("not a url")).toBe("an unreadable URL");
});

test("loggedText gives each web URL in a line as loggedUrl does, and leaves the rest", () => {
  expect(
    loggedText(
      'HttpError: 404 "method: GET url: https://downloads.vrp.moe/eidolon/latest-mac.yml?noCache=1j2k3"',
    ),
  ).toBe('HttpError: 404 "method: GET url: https://downloads.vrp.moe/eidolon/latest-mac.yml"');
  expect(loggedText("from https://a:b@x.test/v1/E.zip?t=1#f, HTTP://y.test/?k")).toBe(
    "from https://x.test/v1/E.zip, http://y.test/",
  );
  expect(loggedText("Found version 0.2.0 (url: Eidolon-0.2.0-arm64-mac.zip)")).toBe(
    "Found version 0.2.0 (url: Eidolon-0.2.0-arm64-mac.zip)",
  );
});

describe("permission requests", () => {
  const microphone: PermissionAsker = {
    window: true,
    mainFrame: true,
    mediaTypes: ["audio"],
    securityOrigin: "eidolon-app://app/",
    frameOrigin: "eidolon-app://app",
  };

  test("the microphone, audio alone, for the app window's main frame at the app's origin", () => {
    expect(requestAction("media", microphone)).toBe("microphone");
  });

  test("not with the camera, nor from a subframe, another webContents or another origin", () => {
    for (const [why, asker] of [
      ["camera too", { ...microphone, mediaTypes: ["audio", "video"] }],
      ["camera", { ...microphone, mediaTypes: ["video"] }],
      ["nothing named", { ...microphone, mediaTypes: [] }],
      ["no types", { ...microphone, mediaTypes: undefined }],
      ["subframe", { ...microphone, mainFrame: false }],
      ["another webContents", { ...microphone, window: false }],
      ["a sandboxed document's opaque origin", { ...microphone, securityOrigin: "null" }],
      ["another host", { ...microphone, securityOrigin: "eidolon-app://other" }],
      ["no origin", { ...microphone, securityOrigin: undefined }],
    ] as const) {
      expect([why, requestAction("media", asker)]).toEqual([why, "deny"]);
    }
  });

  test("clipboard writes for the same frame at the app's origin, by origin rather than URL", () => {
    expect(requestAction("clipboard-sanitized-write", microphone)).toBe("grant");
    expect(requestAction("clipboard-sanitized-write", { ...microphone, frameOrigin: "null" })).toBe(
      "deny",
    );
    expect(requestAction("clipboard-sanitized-write", { ...microphone, mainFrame: false })).toBe(
      "deny",
    );
  });

  test("everything else is denied, from the app's own page too", () => {
    for (const permission of [
      "notifications",
      "geolocation",
      "clipboard-read",
      "display-capture",
      "openExternal",
      "fullscreen",
      "pointerLock",
      "midi",
      "unknown",
    ]) {
      expect([permission, requestAction(permission, microphone)]).toEqual([permission, "deny"]);
    }
  });
});

describe("permission checks", () => {
  test("pass the microphone's audio and clipboard writes for the app's origin in its window", () => {
    expect(checkAllows("media", "eidolon-app://app/", { window: true, mediaType: "audio" })).toBe(
      true,
    );
    expect(checkAllows("clipboard-sanitized-write", "eidolon-app://app", { window: true })).toBe(
      true,
    );
  });

  test("and nothing else: video, another origin, another webContents, what the page never uses", () => {
    expect(checkAllows("media", "eidolon-app://app", { window: true, mediaType: "video" })).toBe(
      false,
    );
    expect(checkAllows("media", "eidolon-app://app", { window: true, mediaType: "unknown" })).toBe(
      false,
    );
    expect(checkAllows("media", "null", { window: true, mediaType: "audio" })).toBe(false);
    expect(checkAllows("media", "eidolon-app://app", { window: false, mediaType: "audio" })).toBe(
      false,
    );
    for (const permission of ["speaker-selection", "background-sync", "notifications"]) {
      expect(checkAllows(permission, "eidolon-app://app", { window: true })).toBe(false);
    }
  });
});

test("macOS asks for the microphone once, and once denied the owner hears where to turn it on", () => {
  expect(microphoneStep("darwin", "granted")).toBe("grant");
  expect(microphoneStep("darwin", "not-determined")).toBe("ask");
  expect(microphoneStep("darwin", "unknown")).toBe("ask");
  expect(microphoneStep("darwin", "denied")).toBe("explain");
  expect(microphoneStep("darwin", "restricted")).toBe("explain");
  expect(microphoneStep("win32", "")).toBe("grant");
});

test("a packaged app refuses either switch that opens CDP; an unpackaged one runs with it", () => {
  for (const name of DEBUGGING_SWITCHES) {
    expect(refusesDebugging(true, (asked) => asked === name)).toBe(true);
    expect(refusesDebugging(false, (asked) => asked === name)).toBe(false);
  }
  expect(DEBUGGING_SWITCHES).toEqual(["remote-debugging-port", "remote-debugging-pipe"]);
  expect(refusesDebugging(true, (asked) => asked === "inspect")).toBe(false);
  expect(refusesDebugging(true, () => false)).toBe(false);
});
