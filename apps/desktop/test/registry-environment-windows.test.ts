// The real registry script on scratch keys under HKCU\Software\Eidolon Test, deleted after.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mergeRegistryEnvironment } from "../src/main/environment.ts";
import { type RegistryValue, readRegistry } from "../src/main/registry-environment.ts";
import { powershellArgs } from "../src/main/update-signature.ts";

const ROOT = `Software\\Eidolon Test\\${randomBytes(8).toString("hex")}`;
const SYSTEM = `HKCU:\\${ROOT}\\System`;
const USER = `HKCU:\\${ROOT}\\User`;
const WIDE = "C:\\工具\\Ünïcödé 🌱";
/** A cold PowerShell on a CI runner can take tens of seconds. */
const TIMEOUT_MS = 120_000;

/** Runs `lines` in Windows PowerShell, stopping at the first error. */
async function powershell(...lines: string[]): Promise<void> {
  await promisify(execFile)(
    "powershell.exe",
    powershellArgs(["$ErrorActionPreference = 'Stop'", ...lines].join("\n")),
    { timeout: TIMEOUT_MS, windowsHide: true },
  );
}

const byName = (values: readonly RegistryValue[]): RegistryValue[] =>
  [...values].sort((a, b) => (a.name < b.name ? -1 : 1));

describe.runIf(process.platform === "win32")("the registry read on Windows", () => {
  beforeAll(async () => {
    await powershell(
      `$system = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${ROOT}\\System')`,
      "$system.SetValue('Path', 'C:\\Eidolon\\system;%SystemRoot%\\eidolon', 'ExpandString')",
      "$system.SetValue('SCRATCH_PLAIN', '%SystemRoot%\\plain', 'String')",
      "$system.SetValue('SCRATCH_NUMBER', 7, 'DWord')",
      "$system.Close()",
      `$user = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${ROOT}\\User')`,
      `$user.SetValue('SCRATCH_WIDE', '${WIDE}', 'String')`,
      "$user.SetValue('SCRATCH_EXPAND', '%SCRATCH_PLAIN%\\more', 'ExpandString')",
      "$user.Close()",
    );
  }, TIMEOUT_MS);

  afterAll(async () => {
    await powershell(
      `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${ROOT}', $false)`,
      // Only while no other test's keys are under it: DeleteSubKey refuses a key with subkeys.
      "try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('Software\\Eidolon Test', $false) } catch {}",
    );
  }, TIMEOUT_MS);

  test(
    "reads REG_SZ and REG_EXPAND_SZ as stored, a value that isn't ASCII whole, and a key with no Path",
    async () => {
      const read = await readRegistry([SYSTEM, USER], { timeoutMs: TIMEOUT_MS });
      if (!("values" in read)) throw new Error(read.failure);
      expect(read.values.map(byName)).toEqual([
        [
          {
            name: "Path",
            kind: "ExpandString",
            value: "C:\\Eidolon\\system;%SystemRoot%\\eidolon",
          },
          { name: "SCRATCH_NUMBER", kind: "DWord", value: "7" },
          { name: "SCRATCH_PLAIN", kind: "String", value: "%SystemRoot%\\plain" },
        ],
        [
          { name: "SCRATCH_EXPAND", kind: "ExpandString", value: "%SCRATCH_PLAIN%\\more" },
          { name: "SCRATCH_WIDE", kind: "String", value: WIDE },
        ],
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    "merges what it read as Windows builds the environment",
    async () => {
      const read = await readRegistry([SYSTEM, USER], { timeoutMs: TIMEOUT_MS });
      if (!("values" in read)) throw new Error(read.failure);
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const launch = { Path: "C:\\Stale", SystemRoot: systemRoot };
      expect(mergeRegistryEnvironment(launch, read.values)).toEqual({
        Path: `C:\\Eidolon\\system;${systemRoot}\\eidolon`,
        SystemRoot: systemRoot,
        SCRATCH_PLAIN: "%SystemRoot%\\plain",
        SCRATCH_WIDE: WIDE,
        SCRATCH_EXPAND: "%SystemRoot%\\plain\\more",
      });
    },
    TIMEOUT_MS,
  );

  test(
    "fails on a key that isn't there",
    async () => {
      await expect(
        readRegistry([`HKCU:\\${ROOT}\\Missing`], { timeoutMs: TIMEOUT_MS }),
      ).resolves.toEqual({ failure: expect.stringMatching(/^exit 1: \S/) });
    },
    TIMEOUT_MS,
  );
});
