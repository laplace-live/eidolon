// The menus as data: what each holds, in either language, Check for Updates… as the updater
// stands, and the desktop companion's checkbox and her own menu.
import { describe, expect, test } from "vitest";
import {
  aboutPanel,
  companionMenu,
  contextMenu,
  macMenu,
  type TrayActions,
  trayMenu,
  updatesItem,
  windowsMenu,
} from "../src/main/menus.ts";
import { STRINGS } from "../src/main/strings.ts";
import type { CompanionMenuState, CompanionPick } from "../src/shared/bridge.ts";

/** A menu item, as the templates give it. */
type MenuItemConstructorOptions = ReturnType<typeof macMenu>[number];

const en = STRINGS.en;
const zh = STRINGS["zh-Hans"];
const MAC = { packaged: true, background: false, updates: "enabled", companion: false } as const;

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
      companion: (on) => {
        calls.push(`companion ${on}`);
      },
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
    expect(macMenu(en, actions, MAC).map((menu) => menu.label)).toEqual([
      "Eidolon",
      "Edit",
      "View",
      "Window",
      "Help",
    ]);
    expect(macMenu(zh, actions, MAC).map((menu) => menu.label)).toEqual([
      "Eidolon",
      "编辑",
      "显示",
      "窗口",
      "帮助",
    ]);
  });

  test("its app menu: About, Check for Updates…, Settings… on ⌘, Services, Hide, Hide Others, Show All, Quit", () => {
    const { actions, calls } = recordingActions();
    const [app] = macMenu(en, actions, MAC);
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
      itemsOf(macMenu(zh, actions, MAC)[0])
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
      itemsOf(macMenu(en, actions, { ...MAC, updates })[0]);
    expect(app("enabled")[1]).toMatchObject({ label: "Check for Updates…", enabled: true });
    expect(app("disabled")[1]).toMatchObject({ label: "Check for Updates…", enabled: false });
    expect(outline(app("hidden")).slice(0, 3)).toEqual(["about", "-", "Settings…"]);
    expect(JSON.stringify(app("hidden"))).not.toMatch(/Update/i);
  });

  test("its Edit menu has every role copy and paste need", () => {
    const { actions } = recordingActions();
    const edit = itemsOf(macMenu(en, actions, MAC)[1]);
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
      outline(itemsOf(macMenu(en, actions, { ...MAC, packaged, updates: "hidden" })[2]));
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
    const menus = macMenu(en, actions, {
      ...MAC,
      packaged: false,
      background: true,
      updates: "hidden",
    });
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

  test("Window minimizes, zooms, closes (which hides), turns the desktop companion on or off and brings all to front; Help opens three things", () => {
    const { actions, calls } = recordingActions();
    const menus = macMenu(en, actions, MAC);
    expect(menus[3]?.role).toBe("window");
    expect(outline(itemsOf(menus[3]))).toEqual([
      "minimize",
      "zoom",
      "-",
      "close",
      "-",
      "Desktop Companion",
      "-",
      "front",
    ]);
    expect(menus[4]?.role).toBe("help");
    const help = itemsOf(menus[4]);
    expect(help.map((item) => item.label)).toEqual(["Show Logs", "Open Data Folder", "Licenses"]);
    for (const item of help) click(item);
    expect(calls).toEqual(["showLogs", "openDataFolder", "licenses"]);
  });

  test("the Window menu's Desktop Companion is a checkbox, checked as she is, whose click turns her the other way", () => {
    const { actions, calls } = recordingActions();
    for (const companion of [false, true]) {
      const windowMenu = itemsOf(macMenu(en, actions, { ...MAC, companion })[3]);
      const item = windowMenu.find((entry) => entry.label === "Desktop Companion");
      expect(item).toMatchObject({ type: "checkbox", checked: companion });
      click(item);
    }
    expect(calls).toEqual(["companion true", "companion false"]);
    expect(itemsOf(macMenu(zh, actions, MAC)[3]).map((item) => item.label)).toContain("桌面形象");
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

test("the tray's menu: Open, Desktop Companion, Settings…, Check for Updates…, Show Logs, Open Data Folder, Licenses, About and Quit", () => {
  const { actions, calls } = recordingActions();
  const items = trayMenu(en, actions, "enabled", false);
  expect(outline(items)).toEqual([
    "Open Eidolon",
    "Desktop Companion",
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
    "companion true",
    "settings",
    "checkForUpdates",
    "showLogs",
    "openDataFolder",
    "licenses",
    "about",
    "quit",
  ]);
  expect(outline(trayMenu(zh, actions, "enabled", false))).toEqual(
    expect.arrayContaining(["桌面形象", "检查更新…", "退出 Eidolon"]),
  );
  expect(trayMenu(en, actions, "disabled", false)[3]).toMatchObject({ enabled: false });
  expect(outline(trayMenu(en, actions, "hidden", false))).not.toContain("Check for Updates…");
});

test("the tray's Desktop Companion is a checkbox, checked as she is, whose click turns her the other way", () => {
  const { actions, calls } = recordingActions();
  expect(trayMenu(en, actions, "hidden", false)[1]).toMatchObject({
    type: "checkbox",
    label: "Desktop Companion",
    checked: false,
  });
  const on = trayMenu(en, actions, "hidden", true)[1];
  expect(on).toMatchObject({ type: "checkbox", checked: true });
  click(on);
  expect(calls).toEqual(["companion false"]);
});

describe("her menu", () => {
  const idle: CompanionMenuState = {
    call: "idle",
    live: false,
    micOn: true,
    models: [
      { id: "milky", name: "奶绿" },
      { id: "tml", name: "TML" },
    ],
    model: "tml",
    outfits: [{ id: "summer", name: "Summer" }],
    outfit: null,
  };
  const own = { size: "medium", alwaysOnTop: true } as const;

  /** Her menu, with the picks its clicks hand on. */
  function menu(state: CompanionMenuState, platform: NodeJS.Platform = "darwin") {
    const picks: CompanionPick[] = [];
    const items = companionMenu(en, state, own, platform, (pick) => picks.push(pick));
    return { items, picks };
  }

  /** The item labelled `label`, among `items` and their submenus. */
  function find(items: MenuItemConstructorOptions[], label: string) {
    const found = items
      .flatMap((item) => [item, ...itemsOf(item)])
      .find((item) => item.label === label);
    if (found === undefined) throw new Error(`no ${label}`);
    return found;
  }

  test("with no call up: Call, Open Eidolon, Appearance, Outfit, Size, Always on Top and Hide, a separator between groups", () => {
    const { items } = menu(idle);
    expect(outline(items)).toEqual([
      "Call",
      "-",
      "Open Eidolon",
      "-",
      "Appearance",
      "Outfit",
      "-",
      "Size",
      "Always on Top",
      "-",
      "Hide",
    ]);
    expect(itemsOf(find(items, "Appearance"))).toMatchObject([
      { type: "radio", label: "奶绿", checked: false },
      { type: "radio", label: "TML", checked: true },
    ]);
    expect(itemsOf(find(items, "Outfit"))).toMatchObject([
      { type: "radio", label: "As Exported", checked: true },
      { type: "radio", label: "Summer", checked: false },
    ]);
    expect(itemsOf(find(items, "Outfit"))[1]).toMatchObject({ checked: false });
    expect(
      itemsOf(menu({ ...idle, outfit: "summer" }).items.find((item) => item.label === "Outfit")),
    ).toMatchObject([{ checked: false }, { checked: true }]);
    expect(itemsOf(find(items, "Size"))).toMatchObject([
      { type: "radio", label: "Small", checked: false },
      { type: "radio", label: "Medium", checked: true },
      { type: "radio", label: "Large", checked: false },
    ]);
    expect(find(items, "Always on Top")).toMatchObject({ type: "checkbox", checked: true });
    const unchecked = companionMenu(
      en,
      idle,
      { size: "large", alwaysOnTop: false },
      "darwin",
      () => {},
    );
    expect(find(unchecked, "Always on Top")).toMatchObject({ checked: false });
    expect(itemsOf(find(unchecked, "Size")).map((item) => item.checked)).toEqual([
      false,
      false,
      true,
    ]);
    expect(outline(companionMenu(zh, idle, own, "darwin", () => {})).slice(0, 3)).toEqual([
      "通话",
      "-",
      "打开 Eidolon",
    ]);
  });

  test("with a call up and live: Hang Up, then Mute Microphone, or Unmute while the microphone is off", () => {
    const up = { ...idle, call: "up", live: true } as const;
    expect(outline(menu(up).items).slice(0, 4)).toEqual([
      "Hang Up",
      "Mute Microphone",
      "-",
      "Open Eidolon",
    ]);
    expect(menu(up).items[1]).toMatchObject({ enabled: true });
    const muted = menu({ ...up, micOn: false }).items;
    expect(outline(muted).slice(0, 2)).toEqual(["Hang Up", "Unmute Microphone"]);
    expect(muted[1]).toMatchObject({ enabled: true });
  });

  test("while the call starts or connects, Hang Up still cancels it and the microphone waits", () => {
    const connecting = menu({ ...idle, call: "up", live: false }).items;
    expect(outline(connecting).slice(0, 2)).toEqual(["Hang Up", "Mute Microphone"]);
    expect(connecting[0]?.enabled).not.toBe(false);
    expect(connecting[1]).toMatchObject({ enabled: false });
    const off = menu({ ...idle, call: "up", live: false, micOn: false }).items;
    expect(off[1]).toMatchObject({ label: "Unmute Microphone", enabled: false });
  });

  test("with models and none active, Appearance checks none, and there is no Outfit", () => {
    const { items } = menu({ ...idle, model: null, outfits: [] });
    expect(outline(items)).toEqual([
      "Call",
      "-",
      "Open Eidolon",
      "-",
      "Appearance",
      "-",
      "Size",
      "Always on Top",
      "-",
      "Hide",
    ]);
    expect(itemsOf(find(items, "Appearance")).map((item) => item.checked)).toEqual([false, false]);
    // An active model past the list's cap checks none either.
    const past = menu({ ...idle, model: "unlisted" }).items;
    expect(itemsOf(find(past, "Appearance")).map((item) => item.checked)).toEqual([false, false]);
  });

  test("with no models and no outfits, neither submenu, and no separator doubles up", () => {
    const { items } = menu({ ...idle, models: [], model: null, outfits: [] });
    expect(outline(items)).toEqual([
      "Call",
      "-",
      "Open Eidolon",
      "-",
      "Size",
      "Always on Top",
      "-",
      "Hide",
    ]);
  });

  test("a model named A & B reads A && B on Windows, whose menus take one & as an access key", () => {
    const named = { ...idle, models: [{ id: "ab", name: "A & B" }], model: "ab" };
    expect(itemsOf(find(menu(named, "win32").items, "Appearance"))[0]?.label).toBe("A && B");
    expect(itemsOf(find(menu(named, "darwin").items, "Appearance"))[0]?.label).toBe("A & B");
  });

  test("every item hands its pick, and only its own", () => {
    const { items, picks } = menu(idle);
    for (const label of [
      "Call",
      "Open Eidolon",
      "奶绿",
      "TML",
      "As Exported",
      "Summer",
      "Small",
      "Medium",
      "Large",
      "Always on Top",
      "Hide",
    ]) {
      click(find(items, label));
    }
    expect(picks).toEqual([
      "call",
      "open",
      "model:milky",
      "model:tml",
      "outfit:",
      "outfit:summer",
      "size:small",
      "size:medium",
      "size:large",
      "always-on-top",
      "hide",
    ]);
    const up = menu({ ...idle, call: "up", live: true });
    click(find(up.items, "Hang Up"));
    click(find(up.items, "Mute Microphone"));
    const muted = menu({ ...idle, call: "up", live: true, micOn: false });
    click(find(muted.items, "Unmute Microphone"));
    expect([...up.picks, ...muted.picks]).toEqual(["hang-up", "mute", "unmute"]);
  });
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
