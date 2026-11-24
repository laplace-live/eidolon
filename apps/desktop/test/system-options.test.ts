// Which copies offer Open at Login and the terminal command, and Open at Login as each OS reads and
// writes it, a launch at login included.
import { describe, expect, test } from "vitest";
import {
  type AppCopy,
  LOGIN_SWITCH,
  type LoginItemRead,
  loginItemQuery,
  loginItemState,
  loginItemWrite,
  openedAtLogin,
  optionsUnavailable,
} from "../src/main/system-options.ts";

describe("optionsUnavailable", () => {
  const mac: AppCopy = {
    background: false,
    packaged: true,
    platform: "darwin",
    inApplications: true,
    installedCopy: true,
  };
  const windows: AppCopy = { ...mac, platform: "win32", inApplications: false };

  test("an installed copy offers them: in /Applications on macOS, NSIS's per-user install on Windows", () => {
    expect(optionsUnavailable(mac)).toBeNull();
    expect(optionsUnavailable(windows)).toBeNull();
  });

  test("background mode never does, packaged or not, wherever it runs", () => {
    for (const copy of [mac, windows]) {
      expect(optionsUnavailable({ ...copy, background: true })).toBe("background");
      expect(optionsUnavailable({ ...copy, background: true, packaged: false })).toBe("background");
    }
  });

  test("nor an unpackaged build, wherever it runs", () => {
    expect(optionsUnavailable({ ...mac, packaged: false })).toBe("unpackaged");
    expect(optionsUnavailable({ ...windows, packaged: false })).toBe("unpackaged");
  });

  test("on macOS, nor a copy outside /Applications; on Windows, nor one outside the install", () => {
    expect(optionsUnavailable({ ...mac, inApplications: false })).toBe("outside-applications");
    expect(optionsUnavailable({ ...windows, installedCopy: false })).toBe("not-installed");
    // Each OS reads its own fact alone.
    expect(optionsUnavailable({ ...mac, installedCopy: false })).toBeNull();
    expect(optionsUnavailable({ ...windows, inApplications: false })).toBeNull();
  });
});

describe("the login item's reads and writes", () => {
  test("on Windows, carry the switch, which getLoginItemSettings must be given to match the entry", () => {
    expect(LOGIN_SWITCH).toBe("--opened-at-login");
    expect(loginItemQuery("win32")).toEqual({ args: [LOGIN_SWITCH] });
    expect(loginItemWrite("win32", true)).toEqual({ openAtLogin: true, args: [LOGIN_SWITCH] });
    expect(loginItemWrite("win32", false)).toEqual({ openAtLogin: false, args: [LOGIN_SWITCH] });
  });

  test("on macOS, register the app itself, with no type and no hidden flag", () => {
    expect(loginItemQuery("darwin")).toEqual({});
    expect(loginItemWrite("darwin", true)).toEqual({ openAtLogin: true });
    expect(loginItemWrite("darwin", false)).toEqual({ openAtLogin: false });
  });
});

describe("loginItemState", () => {
  const settings = (read: Partial<LoginItemRead>): LoginItemRead => ({
    openAtLogin: false,
    status: "not-registered",
    executableWillLaunchAtLogin: false,
    ...read,
  });
  const never = (): LoginItemRead => {
    throw new Error("the login item was read");
  };

  test("is the copy's reason when it can't offer it, and then never reads the OS", () => {
    for (const reason of ["background", "unpackaged", "outside-applications"] as const) {
      expect(loginItemState("darwin", reason, never)).toEqual({ state: "unavailable", reason });
    }
    expect(loginItemState("win32", "not-installed", never)).toEqual({
      state: "unavailable",
      reason: "not-installed",
    });
  });

  test("on macOS, follows SMAppService's status", () => {
    const state = (status: LoginItemRead["status"]) =>
      loginItemState("darwin", null, () => settings({ status, openAtLogin: status === "enabled" }));
    expect(state("enabled")).toEqual({ state: "on" });
    expect(state("requires-approval")).toEqual({ state: "needs-approval" });
    expect(state("not-registered")).toEqual({ state: "off" });
    expect(state("not-found")).toEqual({ state: "unavailable", reason: "outside-applications" });
  });

  test("on Windows, is on only while the entry is there and Startup apps leaves it on", () => {
    const state = (openAtLogin: boolean, executableWillLaunchAtLogin: boolean) =>
      loginItemState("win32", null, () => settings({ openAtLogin, executableWillLaunchAtLogin }));
    expect(state(true, true)).toEqual({ state: "on" });
    // Turned off in Startup apps: the entry stays, its approval doesn't.
    expect(state(true, false)).toEqual({ state: "off" });
    // Another entry for the executable, with other arguments, isn't ours.
    expect(state(false, true)).toEqual({ state: "off" });
    expect(state(false, false)).toEqual({ state: "off" });
  });

  test("reads the OS once per answer", () => {
    let reads = 0;
    const read = () => {
      reads++;
      return settings({ status: "enabled" });
    };
    loginItemState("darwin", null, read);
    expect(reads).toBe(1);
  });
});

describe("openedAtLogin", () => {
  test("on Windows, is the switch on the command line, whatever else is there", () => {
    expect(openedAtLogin("win32", ["Eidolon.exe", LOGIN_SWITCH], false)).toBe(true);
    expect(openedAtLogin("win32", ["Eidolon.exe", "--updated", LOGIN_SWITCH], false)).toBe(true);
    // NSIS's relaunch after an update passes --updated alone, and shows the window as before.
    expect(openedAtLogin("win32", ["Eidolon.exe", "--updated"], true)).toBe(false);
    expect(openedAtLogin("win32", ["Eidolon.exe"], true)).toBe(false);
  });

  test("on macOS, is what the launch said, whatever the command line", () => {
    expect(openedAtLogin("darwin", ["Eidolon"], true)).toBe(true);
    expect(openedAtLogin("darwin", ["Eidolon"], false)).toBe(false);
    expect(openedAtLogin("darwin", ["Eidolon", LOGIN_SWITCH], false)).toBe(false);
  });
});
