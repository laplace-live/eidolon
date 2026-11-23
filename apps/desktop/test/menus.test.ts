// The menus as data: what each holds, in either language, and Check for Updates… as the updater
// stands.
import { describe, expect, test } from "vitest";
import {
  aboutPanel,
  contextMenu,
  macMenu,
  type TrayActions,
  trayMenu,
  updatesItem,
  windowsMenu,
} from "../src/main/menus.ts";
import { STRINGS } from "../src/main/strings.ts";

/** A menu item, as the templates give it. */
type MenuItemConstructorOptions = ReturnType<typeof macMenu>[number];

const en = STRINGS.en;
const zh = STRINGS["zh-Hans"];

function recordingActions(): { actions: TrayActions; calls: string[] } {
  const calls: string[] = [];
  const act = (name: string) => () => {
    calls.push(name);
  };
  return {
    calls,
    actions: {
      settings: act("settings"),
      showLogs: act("showLogs"),
      openDataFolder: act("openDataFolder"),
      licenses: act("licenses"),
      open: act("open"),
      about: act("about"),
      checkForUpdates: act("checkForUpdates"),
      quit: act("quit"),
    },
  };
}

/** A submenu's items. */
function itemsOf(menu: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  return (menu?.submenu ?? []) as MenuItemConstructorOptions[];
}

/** Each item as `role` or `label`, separators as "-". */
function outline(items: MenuItemConstructorOptions[]): string[] {
  return items.map((item) => (item.type === "separator" ? "-" : (item.role ?? item.label ?? "")));
}

/** Calls each item's own click, as a menu would. */
function click(item: MenuItemConstructorOptions | undefined): void {
  (item?.click as (() => void) | undefined)?.();
}

describe("macOS's menu bar", () => {
  test("holds the app, Edit, View, Window and Help menus, worded in the shell's language", () => {
    const { actions } = recordingActions();
    expect(
      macMenu(en, actions, { packaged: true, background: false, updates: "enabled" }).map(
        (menu) => menu.label,
      ),
    ).toEqual(["Eidolon", "Edit", "View", "Window", "Help"]);
    expect(
      macMenu(zh, actions, { packaged: true, background: false, updates: "enabled" }).map(
        (menu) => menu.label,
      ),
    ).toEqual(["Eidolon", "编辑", "显示", "窗口", "帮助"]);
  });

  test("its app menu: About, Check for Updates…, Settings… on ⌘, Services, Hide, Hide Others, Show All, Quit", () => {
    const { actions, calls } = recordingActions();
    const [app] = macMenu(en, actions, { packaged: true, background: false, updates: "enabled" });
    const items = itemsOf(app);
    expect(outline(items)).toEqual([
      "about",
      "Check for Updates…",
      "-",
      "Settings…",
      "-",
      "services",
      "-",
      "hide",
      "hideOthers",
      "unhide",
      "-",
      "quit",
    ]);
    expect(items.map((item) => item.label).filter(Boolean)).toEqual([
      "About Eidolon",
      "Check for Updates…",
      "Settings…",
      "Services",
      "Hide Eidolon",
      "Hide Others",
      "Show All",
      "Quit Eidolon",
    ]);
    expect(
      itemsOf(macMenu(zh, actions, { packaged: true, background: false, updates: "enabled" })[0])
        .map((item) => item.label)
        .slice(1, 6),
    ).toEqual(["检查更新…", undefined, "设置…", undefined, "服务"]);
    const settings = items.find((item) => item.label === "Settings…");
    expect(settings?.accelerator).toBe("Command+,");
    click(settings);
    click(items[1]);
    expect(calls).toEqual(["settings", "checkForUpdates"]);
  });

  test("Check for Updates… is disabled while a check, a download or the restart runs, and absent when this run can't update", () => {
    const { actions } = recordingActions();
    const app = (updates: "enabled" | "disabled" | "hidden") =>
      itemsOf(macMenu(en, actions, { packaged: true, background: false, updates })[0]);
    expect(app("enabled")[1]).toMatchObject({ label: "Check for Updates…", enabled: true });
    expect(app("disabled")[1]).toMatchObject({ label: "Check for Updates…", enabled: false });
    expect(outline(app("hidden")).slice(0, 3)).toEqual(["about", "-", "Settings…"]);
    expect(JSON.stringify(app("hidden"))).not.toMatch(/Update/i);
  });

  test("its Edit menu has every role copy and paste need", () => {
    const { actions } = recordingActions();
    const edit = itemsOf(
      macMenu(en, actions, { packaged: true, background: false, updates: "enabled" })[1],
    );
    expect(outline(edit)).toEqual([
      "undo",
      "redo",
      "-",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "selectAll",
    ]);
    expect(edit.every((item) => item.type === "separator" || item.label)).toBe(true);
  });

  test("View zooms and goes fullscreen; Toggle Developer Tools only unpackaged", () => {
    const { actions } = recordingActions();
    const view = (packaged: boolean) =>
      outline(itemsOf(macMenu(en, actions, { packaged, background: false, updates: "hidden" })[2]));
    expect(view(true)).toEqual(["resetZoom", "zoomIn", "zoomOut", "-", "togglefullscreen"]);
    expect(view(false)).toEqual([
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "-",
      "togglefullscreen",
      "-",
      "toggleDevTools",
    ]);
  });

  test("in background mode, About is the app's own item, which logs the panel, and there are no developer tools", () => {
    const { actions, calls } = recordingActions();
    const menus = macMenu(en, actions, { packaged: false, background: true, updates: "hidden" });
    const [about] = itemsOf(menus[0]);
    expect(about?.role).toBeUndefined();
    expect(about?.label).toBe("About Eidolon");
    click(about);
    expect(calls).toEqual(["about"]);
    expect(outline(itemsOf(menus[2]))).toEqual([
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "-",
      "togglefullscreen",
    ]);
  });

  test("Window minimizes, zooms, closes (which hides) and brings all to front; Help opens three things", () => {
    const { actions, calls } = recordingActions();
    const menus = macMenu(en, actions, { packaged: true, background: false, updates: "enabled" });
    expect(menus[3]?.role).toBe("window");
    expect(outline(itemsOf(menus[3]))).toEqual(["minimize", "zoom", "-", "close", "-", "front"]);
    expect(menus[4]?.role).toBe("help");
    const help = itemsOf(menus[4]);
    expect(help.map((item) => item.label)).toEqual(["Show Logs", "Open Data Folder", "Licenses"]);
    for (const item of help) click(item);
    expect(calls).toEqual(["showLogs", "openDataFolder", "licenses"]);
  });
});

test("Windows' menu holds View's zoom roles alone, whose accelerators work with no menu bar", () => {
  const [view, ...others] = windowsMenu(en);
  expect(others).toEqual([]);
  expect(view?.label).toBe("View");
  expect(outline(itemsOf(view))).toEqual(["resetZoom", "zoomIn", "zoomOut"]);
  expect(itemsOf(windowsMenu(zh)[0]).map((item) => item.label)).toEqual([
    "实际大小",
    "放大",
    "缩小",
  ]);
});

test("the tray's menu: Open, Settings…, Check for Updates…, Show Logs, Open Data Folder, Licenses, About and Quit", () => {
  const { actions, calls } = recordingActions();
  const items = trayMenu(en, actions, "enabled");
  expect(outline(items)).toEqual([
    "Open Eidolon",
    "Settings…",
    "Check for Updates…",
    "-",
    "Show Logs",
    "Open Data Folder",
    "Licenses",
    "About Eidolon",
    "-",
    "Quit Eidolon",
  ]);
  for (const item of items) click(item);
  expect(calls).toEqual([
    "open",
    "settings",
    "checkForUpdates",
    "showLogs",
    "openDataFolder",
    "licenses",
    "about",
    "quit",
  ]);
  expect(outline(trayMenu(zh, actions, "enabled"))).toEqual(
    expect.arrayContaining(["检查更新…", "退出 Eidolon"]),
  );
  expect(trayMenu(en, actions, "disabled")[2]).toMatchObject({ enabled: false });
  expect(outline(trayMenu(en, actions, "hidden"))).not.toContain("Check for Updates…");
});

test("updatesItem: hidden while unsupported, disabled while a check, a download or the restart runs", () => {
  expect(updatesItem("unsupported")).toBe("hidden");
  for (const phase of ["checking", "downloading", "installing"] as const) {
    expect([phase, updatesItem(phase)]).toEqual([phase, "disabled"]);
  }
  // Read-only: its box says to move the app.
  for (const phase of ["idle", "available", "downloaded", "error", "read-only"] as const) {
    expect([phase, updatesItem(phase)]).toEqual([phase, "enabled"]);
  }
});

describe("the context menu", () => {
  const flags = { canCut: true, canCopy: true, canPaste: false, canSelectAll: true };

  test("in a field: cut, copy, paste and select all, enabled as the field allows", () => {
    const items = contextMenu(en, { isEditable: true, selectionText: "", editFlags: flags });
    expect(outline(items)).toEqual(["cut", "copy", "paste", "-", "selectAll"]);
    expect(items.map((item) => item.enabled)).toEqual([true, true, false, undefined, true]);
    expect(items[0]?.label).toBe("Cut");
    expect(
      contextMenu(zh, { isEditable: true, selectionText: "", editFlags: flags })[1]?.label,
    ).toBe("复制");
  });

  test("over selected text: copy; elsewhere: nothing to show", () => {
    expect(
      outline(contextMenu(en, { isEditable: false, selectionText: "奶绿", editFlags: flags })),
    ).toEqual(["copy"]);
    expect(contextMenu(en, { isEditable: false, selectionText: "", editFlags: flags })).toEqual([]);
  });
});

describe("the About panel", () => {
  const versions = { version: "0.1.0", serverVersion: "0.13.0" };

  test("names the app's version and the server's beside it", () => {
    expect(aboutPanel("darwin", versions, en, "/icon.ico")).toEqual({
      applicationName: "Eidolon",
      applicationVersion: "0.1.0",
      version: "Server 0.13.0",
    });
    expect(aboutPanel("win32", versions, zh, "C:\\icon.ico")).toEqual({
      applicationName: "Eidolon",
      applicationVersion: "0.1.0",
      credits: "服务器 0.13.0",
      iconPath: "C:\\icon.ico",
    });
  });

  test("before any server has answered, names the app's alone", () => {
    expect(aboutPanel("darwin", { ...versions, serverVersion: "" }, en, "")).toMatchObject({
      applicationVersion: "0.1.0",
      version: "",
    });
  });
});
