// The desktop updater's UI and check flow: title-bar badge visibility/icons per phase,
// UpdateDialog states (available with release notes, downloading progress, ready to install,
// error, read-only, idle), and checkForUpdates() toast/dialog outcomes.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EidolonDesktop, ReleaseNoteEntry, UpdateState } from "@/lib/desktop";
import { mountFakeDom } from "@/test/fake-dom";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

let renderClosedDialog = false;

const toastCalls = {
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
};

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
vi.doMock("sonner", () => ({ toast: toastCalls }));
vi.doMock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children?: ReactNode }) =>
    open || renderClosedDialog
      ? createElement("div", { "data-slot": "dialog", "data-open": String(open) }, children)
      : null,
  DialogContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", { "data-slot": "dialog-content" }, children),
  DialogHeader: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", { "data-slot": "dialog-header" }, children),
  DialogTitle: ({ children }: { readonly children?: ReactNode }) =>
    createElement("h2", { "data-slot": "dialog-title" }, children),
  DialogDescription: ({ children }: { readonly children?: ReactNode }) =>
    createElement("p", { "data-slot": "dialog-description" }, children),
  DialogFooter: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", { "data-slot": "dialog-footer" }, children),
}));

const { DESKTOP_PACKAGE, setUpdateState } = await import("@/lib/desktop");
const { checkForUpdates, setUpdateOpen, subscribeUpdateOpen, updateOpen } = await import(
  "@/lib/update-check"
);
const { UpdateVersion } = await import("./update-version");
const { UpdateDialog, UpdateDialogHost } = await import("./update-dialog");
const { TooltipProvider } = await import("./ui/tooltip");

const NOTES: readonly ReleaseNoteEntry[] = [
  {
    date: "2026-11-26T10:00:00Z",
    versions: { [DESKTOP_PACKAGE]: "0.7.0" },
    items: [
      { kind: "feature", packages: [DESKTOP_PACKAGE], text: "Show updates in app" },
      { kind: "performance", packages: [DESKTOP_PACKAGE], text: "Start faster" },
      { kind: "improvement", packages: [DESKTOP_PACKAGE], text: "Better layout" },
      { kind: "fix", packages: [DESKTOP_PACKAGE], text: "Fix reload loop" },
      { kind: "other", packages: [DESKTOP_PACKAGE], text: "Misc change" },
    ],
  },
];

function renderVersion(): string {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(TooltipProvider, null, createElement(UpdateVersion)),
    ),
  );
}

function renderDialog(update: UpdateState, open = true): string {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(UpdateDialog, { open, onOpenChange: () => {}, update, appVersion: "0.6.0" }),
    ),
  );
}

function fakeBridge(overrides: Partial<EidolonDesktop> = {}): EidolonDesktop {
  const ignore = () => {};
  return {
    platform: "darwin",
    version: "0.6.0",
    serverVersion: "0.18.0",
    setTheme: ignore,
    setLanguage: ignore,
    onCommand: ignore,
    ...overrides,
  };
}

afterEach(() => {
  renderClosedDialog = false;
  globalThis.eidolonDesktop = undefined;
  setUpdateState({ phase: "unsupported" });
  setUpdateOpen(false);
  toastCalls.loading.mockReset();
  toastCalls.success.mockReset();
  toastCalls.error.mockReset();
  toastCalls.dismiss.mockReset();
});

describe("UpdateVersion", () => {
  test("renders nothing until an update phase carries a version", () => {
    for (const phase of ["unsupported", "read-only", "idle", "checking"] as const) {
      setUpdateState({ phase });
      expect(renderVersion()).toBe("");
    }
  });

  test("renders the version badge with Show Update Status label when a version is active", () => {
    for (const state of [
      { phase: "available", version: "0.7.0", notes: [] },
      { phase: "downloading", version: "0.7.0", percent: 45 },
      { phase: "downloaded", version: "0.7.0", notes: [] },
      { phase: "installing", version: "0.7.0", notes: [] },
      { phase: "error", version: "0.7.0", message: "network drop" },
    ] as const) {
      setUpdateState(state);
      const markup = renderVersion();
      expect(markup).toContain("v0.7.0");
      expect(markup).toContain('aria-label="Show Update Status"');
    }
  });
});

describe("UpdateDialog", () => {
  test("available shows version comparison, badged release notes, and Skip/Later/Update actions", () => {
    const markup = renderDialog({ phase: "available", version: "0.7.0", notes: NOTES });
    expect(markup).toContain("Update Available");
    expect(markup).toContain("v0.7.0 is ready to download. You&#x27;re on v0.6.0.");
    for (const kind of ["New", "Perf", "Improved", "Fixed", "Other"]) {
      expect(markup).toContain(kind);
    }
    expect(markup).toContain("Show updates in app");
    expect(markup).toContain("Skip This Version");
    expect(markup).toContain("Later");
    expect(markup).toContain(">Update<");
    expect(markup).toContain("whitespace-pre-line");
  });

  test("downloading shows progress percentage and keeps the app usable", () => {
    const markup = renderDialog({ phase: "downloading", version: "0.7.0", percent: 65 });
    expect(markup).toContain("Downloading v0.7.0…");
    expect(markup).toContain("The app stays usable");
    expect(markup).toContain("65%");
  });

  test("downloaded and installing show release notes and lock the relaunch button once installing", () => {
    const downloaded = renderDialog({ phase: "downloaded", version: "0.7.0", notes: NOTES });
    expect(downloaded).toContain("Ready to Install");
    expect(downloaded).toContain("Relaunch Now");
    expect(downloaded).toContain("Show updates in app");

    const installing = renderDialog({ phase: "installing", version: "0.7.0", notes: NOTES });
    expect(installing).toContain("Relaunching…");
    expect(installing).toContain('disabled=""');
  });

  test("error, read-only, and idle render their respective prompts", () => {
    const err = renderDialog({ phase: "error", version: "0.7.0", message: "HTTP 502" });
    expect(err).toContain("Update Failed");
    expect(err).toContain("HTTP 502");
    expect(err).toContain("Retry");

    const readOnly = renderDialog({ phase: "read-only" });
    expect(readOnly).toContain("Move to Applications");
    expect(readOnly).toContain("OK");

    const idle = renderDialog({ phase: "idle" });
    expect(idle).toContain("No Update in Progress");
    expect(idle).toContain("You&#x27;re on v0.6.0.");
  });
});

describe("checkForUpdates", () => {
  test("opens the dialog directly when a version or read-only notice is already active", () => {
    const updateCheck = vi.fn();
    globalThis.eidolonDesktop = fakeBridge({ updateCheck });
    for (const state of [
      { phase: "available", version: "0.7.0", notes: [] },
      { phase: "read-only" },
    ] as const) {
      setUpdateOpen(false);
      setUpdateState(state);
      checkForUpdates();
      expect(updateOpen()).toBe(true);
      expect(updateCheck).not.toHaveBeenCalled();
    }
  });

  test("toasts loading then dismisses and opens dialog when an update is found", async () => {
    const updateCheck = vi.fn().mockResolvedValue({ outcome: "available", version: "0.7.0" });
    globalThis.eidolonDesktop = fakeBridge({ updateCheck });
    setUpdateState({ phase: "idle" });
    checkForUpdates();
    expect(toastCalls.loading).toHaveBeenCalledWith("Checking for updates…", {
      id: "update-check",
    });
    await vi.waitFor(() => expect(toastCalls.dismiss).toHaveBeenCalledWith("update-check"));
    expect(updateOpen()).toBe(true);
  });

  test("toasts up to date or error when none or failed", async () => {
    const updateCheck = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "none" })
      .mockResolvedValueOnce({ outcome: "error", message: "offline" });
    globalThis.eidolonDesktop = fakeBridge({ updateCheck });
    setUpdateState({ phase: "idle" });

    checkForUpdates();
    await vi.waitFor(() =>
      expect(toastCalls.success).toHaveBeenCalledWith("You're up to date", {
        id: "update-check",
      }),
    );

    checkForUpdates();
    await vi.waitFor(() =>
      expect(toastCalls.error).toHaveBeenCalledWith("Update check failed: offline", {
        id: "update-check",
      }),
    );
  });

  test("updateOpen store deduplicates unchanged open state", () => {
    const seen: boolean[] = [];
    const stop = subscribeUpdateOpen(() => seen.push(updateOpen()));
    setUpdateOpen(true);
    setUpdateOpen(true);
    setUpdateOpen(false);
    expect(seen).toEqual([true, false]);
    stop();
  });
});

describe("UpdateDialogHost", () => {
  test("retains the active update phase while the closing dialog animates out across a transition to idle", async () => {
    renderClosedDialog = true;
    globalThis.eidolonDesktop = fakeBridge();
    setUpdateState({ phase: "available", version: "0.7.0", notes: NOTES });
    setUpdateOpen(true);
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    const tree = () => createElement(I18nProvider, { i18n }, createElement(UpdateDialogHost));
    const mounted = await mountFakeDom(tree());
    try {
      expect(mounted.container.innerHTML).toContain('data-open="true"');
      expect(mounted.container.textContent).toContain("Update Available");

      // Simulate Skip This Version closing the dialog while main transitions state to idle
      // and a parent re-render occurs before Radix's closing animation unmounts content.
      await mounted.act(() => {
        setUpdateOpen(false);
        setUpdateState({ phase: "idle" });
      });
      await mounted.render(tree());
      expect(mounted.container.innerHTML).toContain('data-open="false"');
      expect(mounted.container.textContent).toContain("Update Available");
      expect(mounted.container.textContent).not.toContain("No Update in Progress");

      await mounted.act(() => {
        setUpdateOpen(true);
      });
      expect(mounted.container.innerHTML).toContain('data-open="true"');
      expect(mounted.container.textContent).toContain("No Update in Progress");
    } finally {
      await mounted.unmount();
    }
  });
});
