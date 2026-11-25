// Upgrading from Eidolon (<appData>/Eidolon) to LAPLACE Eidolon (<appData>/LAPLACE Eidolon).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { COMPANION_FILE, readCompanion, writeCompanion } from "../src/main/companion.ts";
import { MIGRATED_MARKER, migrateLegacyProfile, TRAY_NOTICE_MARKER } from "../src/main/profile.ts";
import { BOUNDS_FILE, readBounds, writeBounds } from "../src/main/window-options.ts";

let appData: string;
beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), "eidolon-profile-"));
});
afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
});

function populateLegacy(legacy: string): void {
  writeBounds(join(legacy, BOUNDS_FILE), {
    x: 120,
    y: 80,
    width: 1400,
    height: 900,
    maximized: true,
  });
  writeCompanion(join(legacy, COMPANION_FILE), {
    on: true,
    showAtLogin: true,
    alwaysOnTop: false,
    size: "large",
    feet: { x: 800, y: 900 },
  });
  writeFileSync(join(legacy, TRAY_NOTICE_MARKER), "");
  mkdirSync(join(legacy, "Local Storage", "leveldb"), { recursive: true });
  writeFileSync(join(legacy, "Local Storage", "leveldb", "000003.log"), "zh-Hans");
  writeFileSync(join(legacy, "Local Storage", "leveldb", "LOCK"), "");
}

describe("migrateLegacyProfile", () => {
  test("does nothing when no Eidolon profile exists", () => {
    const userData = join(appData, "LAPLACE Eidolon");
    migrateLegacyProfile(appData, userData);
    expect(existsSync(userData)).toBe(false);
  });

  test("copies saved state and Local Storage while leaving <appData>/Eidolon and its locks in place", () => {
    const legacy = join(appData, "Eidolon");
    const userData = join(appData, "LAPLACE Eidolon");
    populateLegacy(legacy);
    if (process.platform !== "win32") {
      symlinkSync("host-12345", join(legacy, "SingletonLock"));
    }

    migrateLegacyProfile(appData, userData);

    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(userData, "SingletonLock"))).toBe(false);
    expect(existsSync(join(userData, MIGRATED_MARKER))).toBe(true);
    expect(readBounds(join(userData, BOUNDS_FILE))).toEqual({
      x: 120,
      y: 80,
      width: 1400,
      height: 900,
      maximized: true,
    });
    expect(readCompanion(join(userData, COMPANION_FILE))).toEqual({
      on: true,
      showAtLogin: true,
      alwaysOnTop: false,
      size: "large",
      feet: { x: 800, y: 900 },
    });
    expect(existsSync(join(userData, TRAY_NOTICE_MARKER))).toBe(true);
    expect(readFileSync(join(userData, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe(
      "zh-Hans",
    );
    expect(existsSync(join(userData, "Local Storage", "leveldb", "LOCK"))).toBe(false);
  });

  test("retries when an earlier launch failed before writing the completion marker", () => {
    const legacy = join(appData, "Eidolon");
    const userData = join(appData, "LAPLACE Eidolon");
    populateLegacy(legacy);
    mkdirSync(userData, { recursive: true });
    // Simulate a partial copy that wrote companion.json and was updated by the user, without the marker.
    writeCompanion(join(userData, COMPANION_FILE), {
      on: false,
      showAtLogin: true,
      alwaysOnTop: true,
      size: "small",
      feet: null,
    });

    migrateLegacyProfile(appData, userData);

    expect(existsSync(join(userData, MIGRATED_MARKER))).toBe(true);
    expect(readCompanion(join(userData, COMPANION_FILE)).on).toBe(false);
    expect(readBounds(join(userData, BOUNDS_FILE))?.width).toBe(1400);
    expect(readFileSync(join(userData, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe(
      "zh-Hans",
    );
  });

  test("skips once the completion marker is present", () => {
    const legacy = join(appData, "Eidolon");
    const userData = join(appData, "LAPLACE Eidolon");
    populateLegacy(legacy);
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, MIGRATED_MARKER), "");

    migrateLegacyProfile(appData, userData);

    expect(existsSync(join(userData, BOUNDS_FILE))).toBe(false);
    expect(existsSync(join(userData, COMPANION_FILE))).toBe(false);
    expect(existsSync(join(userData, TRAY_NOTICE_MARKER))).toBe(false);
  });
});
