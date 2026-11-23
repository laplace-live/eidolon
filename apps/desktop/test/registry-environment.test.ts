import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  parseRegistryOutput,
  readRegistry,
  registryScript,
} from "../src/main/registry-environment.ts";

const KEYS = ["HKCU:\\Software\\Eidolon Test\\System", "HKCU:\\Software\\Eidolon Test\\User"];
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eidolon-registry-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
 * A stand-in powershell.exe on the PATH of `env`: it checks it was given an encoded script, keeps
 * the script, then runs `body`.
 */
function powershell(body: string): {
  readonly env: NodeJS.ProcessEnv;
  readonly script: () => string;
} {
  const kept = join(directory, "script");
  const path = join(directory, "powershell.exe");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      '[ "$1 $2 $3 $4 $5" = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand" ] || exit 64',
      `printf %s "$6" > '${kept}'`,
      body,
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return {
    env: { PATH: `${directory}:/usr/bin:/bin` },
    script: () => Buffer.from(readFileSync(kept, "utf8"), "base64").toString("utf16le"),
  };
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("registryScript", () => {
  test("takes each key as a literal, and prints its values unexpanded with their kinds, as UTF-8", () => {
    const script = registryScript(["HKCU:\\Software\\it's", "HKCU:\\Environment"]);
    expect(script).toContain("$keys = @('HKCU:\\Software\\it''s', 'HKCU:\\Environment')");
    expect(script).toContain("$key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')");
    expect(script).toContain("[string]$key.GetValueKind($name)");
    expect(script).toContain("[Console]::OutputEncoding = [Text.Encoding]::UTF8");
  });
});

describe("parseRegistryOutput", () => {
  test("puts each value under its key, in order, ended at its first NUL", () => {
    const output = JSON.stringify([
      { Key: 0, Name: "Path", Kind: "ExpandString", Value: "%SystemRoot%\\system32" },
      { Key: 2, Name: "USERNAME", Kind: "String", Value: "owner" },
      { Key: 0, Name: "OS", Kind: "String", Value: "Windows_NT\u0000" },
    ]);
    expect(parseRegistryOutput(`${output}\r\n`, 3)).toEqual([
      [
        { name: "Path", kind: "ExpandString", value: "%SystemRoot%\\system32" },
        { name: "OS", kind: "String", value: "Windows_NT" },
      ],
      [],
      [{ name: "USERNAME", kind: "String", value: "owner" }],
    ]);
    expect(parseRegistryOutput("[]", 2)).toEqual([[], []]);
  });

  test("refuses any other output", () => {
    const record = { Key: 0, Name: "A", Kind: "String", Value: "a" };
    for (const output of [
      "",
      "Get-Item : Access is denied.",
      JSON.stringify(record),
      JSON.stringify([1]),
      JSON.stringify([null]),
      JSON.stringify([{ ...record, Key: 2 }]),
      JSON.stringify([{ ...record, Key: 0.5 }]),
      JSON.stringify([{ ...record, Key: "0" }]),
      JSON.stringify([{ ...record, Value: 1 }]),
      JSON.stringify([{ Key: 0, Name: "A", Kind: "String" }]),
    ]) {
      expect(parseRegistryOutput(output, 2), output).toBeUndefined();
    }
  });
});

// The stand-in powershell.exe is a POSIX script.
describe.skipIf(process.platform === "win32")("readRegistry", () => {
  test("runs the script encoded, on the environment given but PSModulePath, and returns each key's values", async () => {
    const records = join(directory, "registry.json");
    const seen = join(directory, "env");
    writeFileSync(
      records,
      JSON.stringify([{ Key: 1, Name: "Path", Kind: "ExpandString", Value: "C:\\工具;%TOOLS%" }]),
    );
    const stand = powershell(`env > '${seen}'\ncat '${records}'`);
    const env = { ...stand.env, PSModulePath: "C:\\pwsh\\Modules", psmodulepath: "x", KEPT: "1" };
    await expect(readRegistry(KEYS, { env })).resolves.toEqual({
      values: [[], [{ name: "Path", kind: "ExpandString", value: "C:\\工具;%TOOLS%" }]],
    });
    expect(stand.script()).toBe(registryScript(KEYS));
    const given = readFileSync(seen, "utf8");
    expect(given).toMatch(/^KEPT=1$/m);
    expect(given).not.toMatch(/^psmodulepath=/im);
  });

  test("reports PowerShell's exit with the first line it printed on stderr, output it can't read, and a spawn that fails", async () => {
    const said = powershell("printf 'Access is denied.\\r\\nAt line:1 char:1\\n' >&2; exit 1");
    await expect(readRegistry(KEYS, { env: said.env })).resolves.toEqual({
      failure: "exit 1: Access is denied.",
    });
    const quiet = powershell("exit 3");
    await expect(readRegistry(KEYS, { env: quiet.env })).resolves.toEqual({ failure: "exit 3" });
    const garbled = powershell("echo 'not JSON'");
    await expect(readRegistry(KEYS, { env: garbled.env })).resolves.toEqual({
      failure: "unparsed",
    });
    await expect(readRegistry(KEYS, { env: { PATH: "/usr/bin:/bin" } })).resolves.toEqual({
      failure: "spawn powershell.exe ENOENT",
    });
  });

  test("kills PowerShell past its deadline", async () => {
    const pid = join(directory, "pid");
    const stand = powershell(`echo $$ > '${pid}'\nexec sleep 30`);
    await expect(readRegistry(KEYS, { env: stand.env, timeoutMs: 1_000 })).resolves.toEqual({
      failure: "timeout",
    });
    const child = Number(readFileSync(pid, "utf8"));
    await vi.waitFor(() => expect(running(child)).toBe(false));
  });

  test("kills PowerShell on abort, and starts none when already aborted", async () => {
    const pid = join(directory, "pid");
    const stand = powershell(`echo $$ > '${pid}'\nexec sleep 30`);
    const controller = new AbortController();
    const read = readRegistry(KEYS, { env: stand.env, signal: controller.signal });
    const child = await vi.waitFor(() => {
      const value = Number(readFileSync(pid, "utf8"));
      expect(value).toBeGreaterThan(0);
      return value;
    });
    controller.abort();
    await expect(read).resolves.toEqual({ failure: "aborted" });
    await vi.waitFor(() => expect(running(child)).toBe(false));
    rmSync(pid);
    await expect(
      readRegistry(KEYS, { env: stand.env, signal: AbortSignal.abort() }),
    ).resolves.toEqual({ failure: "aborted" });
    expect(existsSync(pid)).toBe(false);
  });
});
