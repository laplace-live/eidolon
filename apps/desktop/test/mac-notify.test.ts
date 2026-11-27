import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { buildMacNotify, macNotifyOutput } from "../scripts/build-mac-notify.ts";

describe("mac-notify", () => {
  test("skips compilation outside macOS", () => {
    expect(buildMacNotify("linux")).toBeNull();
    expect(buildMacNotify("win32")).toBeNull();
  });

  describe.skipIf(process.platform !== "darwin")("on macOS", () => {
    test("builds mac_notify.node and loads init, show, and close", () => {
      const built = buildMacNotify();
      expect(built).toBe(macNotifyOutput());
      expect(existsSync(macNotifyOutput())).toBe(true);

      const require = createRequire(import.meta.url);
      const addon = require(macNotifyOutput()) as {
        init: (
          onClick: (id: string) => void,
          onFailed: (id: string, error: string) => void,
        ) => void;
        show: (options: { id: string; title: string; body: string }) => void;
        close: (id: string) => void;
        getStatus: (callback: (status: string) => void) => void;
        requestPermission: (callback: (status: string) => void) => void;
      };
      expect(typeof addon.init).toBe("function");
      expect(typeof addon.show).toBe("function");
      expect(typeof addon.close).toBe("function");
      expect(typeof addon.getStatus).toBe("function");
      expect(typeof addon.requestPermission).toBe("function");
    });

    test("runs safely in plain Node without a bundle identifier and lets Node exit", () => {
      buildMacNotify();
      const script = `
        const { createRequire } = require("node:module");
        const addon = createRequire(process.env.ADDON_PATH)(process.env.ADDON_PATH);
        const failures = [];
        const statuses = {};
        addon.init(() => {}, (id, error) => failures.push({ id, error }));
        addon.show({ id: "test-1", title: "Milky", body: "Hello" });
        addon.close("test-1");
        addon.getStatus((status) => {
          statuses.current = status;
          addon.requestPermission((next) => {
            statuses.requested = next;
            console.log(JSON.stringify({ failures, statuses }));
          });
        });
      `;
      const run = spawnSync(process.execPath, ["-e", script], {
        env: { ...process.env, ADDON_PATH: macNotifyOutput() },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      const parsed = JSON.parse(run.stdout.trim()) as {
        failures: { id: string; error: string }[];
        statuses: { current: string; requested: string };
      };
      expect(parsed.failures).toHaveLength(1);
      expect(parsed.failures[0]).toEqual({
        id: "test-1",
        error: "application bundle has no CFBundleIdentifier",
      });
      expect(parsed.statuses).toEqual({
        current: "unavailable",
        requested: "unavailable",
      });
    });
  });
});
