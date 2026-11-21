// The packaged smoke's own helpers, without Electron or Windows: a packaged app's layout, command
// lines as ps and Windows give them, the natives lsof and PowerShell list, the photo and icon it
// reads, the logs' errors and leaks, the processes naming a run's folder, a folder's hashes, and
// the NSIS setup's uninstall entry and silent uninstall.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ENTRIES_SCRIPT,
  namesUninstaller,
  silentUninstall,
  UNINSTALL_KEY,
} from "../scripts/smoke/nsis.ts";
import {
  appLayout,
  changedFiles,
  fileHashes,
  icoImages,
  inside,
  jpegFacts,
  jsonList,
  leaks,
  lineTime,
  lsofLibraries,
  modulesScript,
  powershellCommand,
  processesNaming,
  ROTATED_PHOTO,
  runsOnBinary,
  strayErrorLines,
  windowsArgs,
} from "../scripts/smoke/packaged.ts";

const MAC_APP = "/Users/runner/work/eidolon/apps/desktop/.out/mac-arm64/Eidolon.app";
const MAC_BINARY = `${MAC_APP}/Contents/MacOS/Eidolon`;
const MAC_PAYLOAD = `${MAC_APP}/Contents/Resources/eidolon`;
const WIN_FOLDER = "C:\\Users\\runneradmin\\AppData\\Local\\Programs\\eidolon";
const WIN_BINARY = `${WIN_FOLDER}\\Eidolon.exe`;
const WIN_PAYLOAD = `${WIN_FOLDER}\\resources\\eidolon`;
const WIN_UNINSTALLER = `${WIN_FOLDER}\\Uninstall Eidolon.exe`;

describe("a packaged app's layout", () => {
  test("on macOS: the bundle's Resources hold the payload and the tray icon", () => {
    expect(appLayout(MAC_BINARY, "darwin")).toEqual({
      binary: MAC_BINARY,
      resources: `${MAC_APP}/Contents/Resources`,
      payload: MAC_PAYLOAD,
      trayIcon: `${MAC_APP}/Contents/Resources/assets/tray-icon.ico`,
    });
  });

  test("on Windows: resources beside Eidolon.exe, by Windows' paths on any OS", () => {
    expect(appLayout(WIN_BINARY, "win32")).toEqual({
      binary: WIN_BINARY,
      resources: `${WIN_FOLDER}\\resources`,
      payload: WIN_PAYLOAD,
      trayIcon: `${WIN_FOLDER}\\resources\\assets\\tray-icon.ico`,
    });
  });
});

describe("command lines", () => {
  test("Windows' split as the C runtime splits them: quotes, spaces, backslashes", () => {
    expect(windowsArgs('"C:\\Program Files\\x.exe" --a  b\t"c d"')).toEqual([
      "C:\\Program Files\\x.exe",
      "--a",
      "b",
      "c d",
    ]);
    expect(windowsArgs('"C:\\dir\\\\" next')).toEqual(["C:\\dir\\", "next"]);
    expect(windowsArgs('say \\"hi\\" a\\\\b ""')).toEqual(["say", '"hi"', "a\\\\b", ""]);
    expect(windowsArgs("  ")).toEqual([]);
  });

  test("the backend on macOS as ps shows it: the binary, main's runtime arguments, the script", () => {
    const server = `${MAC_PAYLOAD}/dist/server.js`;
    const command = `${MAC_BINARY} --disable-sigusr1 --use-system-ca ${server} --host 127.0.0.1 --port 0 --no-open`;
    expect(runsOnBinary(command, MAC_BINARY, server, "darwin")).toBe(true);
    expect(
      runsOnBinary(`${MAC_BINARY} --disable-sigusr1 ${server}`, MAC_BINARY, server, "darwin"),
    ).toBe(false);
    expect(runsOnBinary(command, MAC_BINARY, `${MAC_PAYLOAD}/dist/cli.js`, "darwin")).toBe(false);
    expect(
      runsOnBinary(
        command.replace(MAC_APP, "/Applications/Eidolon.app"),
        MAC_BINARY,
        server,
        "darwin",
      ),
    ).toBe(false);
  });

  test("a job on Windows, quoted or not, whatever the case Windows reports", () => {
    const cli = `${WIN_PAYLOAD}\\dist\\cli.js`;
    const plain = `${WIN_BINARY} --disable-sigusr1 --use-system-ca ${cli} ingest-facts --json`;
    expect(runsOnBinary(plain, WIN_BINARY, cli, "win32")).toBe(true);
    expect(runsOnBinary(plain.toLowerCase(), WIN_BINARY, cli, "win32")).toBe(true);
    const spaced = "C:\\Users\\John Doe\\AppData\\Local\\Programs\\eidolon";
    const quoted = `"${spaced}\\Eidolon.exe" --disable-sigusr1 --use-system-ca "${spaced}\\resources\\eidolon\\dist\\cli.js" ingest-facts`;
    expect(
      runsOnBinary(
        quoted,
        `${spaced}\\Eidolon.exe`,
        `${spaced}\\resources\\eidolon\\dist\\cli.js`,
        "win32",
      ),
    ).toBe(true);
    expect(runsOnBinary(plain, WIN_BINARY, `${WIN_PAYLOAD}\\dist\\server.js`, "win32")).toBe(false);
  });
});

describe("where a library was mapped from", () => {
  test("inside the payload, by its folder, not a sibling's with the same prefix", () => {
    expect(inside(`${MAC_PAYLOAD}/node_modules/x.node`, MAC_PAYLOAD, "darwin")).toBe(true);
    expect(inside(`${MAC_PAYLOAD}2/node_modules/x.node`, MAC_PAYLOAD, "darwin")).toBe(false);
    expect(inside(MAC_PAYLOAD, MAC_PAYLOAD, "darwin")).toBe(false);
    expect(inside("/usr/lib/libc++.dylib", MAC_PAYLOAD, "darwin")).toBe(false);
  });

  test("on Windows without case, and without process.report's \\\\?\\ prefix", () => {
    const dll = `\\\\?\\${WIN_PAYLOAD.toUpperCase()}\\node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\vcruntime140.dll`;
    expect(inside(dll, WIN_PAYLOAD, "win32")).toBe(true);
    expect(inside("C:\\Windows\\System32\\vcruntime140.dll", WIN_PAYLOAD, "win32")).toBe(false);
  });

  test("lsof's mapped .node and .dylib files, spaces in their paths kept", () => {
    const text = [
      "COMMAND   PID      USER   FD   TYPE DEVICE  SIZE/OFF     NODE NAME",
      "Eidolon 67738 sparanoid  cwd    DIR   1,17       640        2 /",
      `Eidolon 67738 sparanoid  txt    REG   1,17  1234567 12345678 ${MAC_PAYLOAD}/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node`,
      "Eidolon 67738 sparanoid  txt    REG   1,17    23456 23456789 /Users/x/My Apps/libvips-cpp.8.18.7.dylib",
      "Eidolon 67738 sparanoid  txt    REG   1,17    34567 34567890 /usr/lib/dyld",
      "Eidolon 67738 sparanoid   12u  IPv4 0x1234      0t0      TCP 127.0.0.1:51054 (LISTEN)",
    ].join("\n");
    expect(lsofLibraries(text)).toEqual([
      `${MAC_PAYLOAD}/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node`,
      "/Users/x/My Apps/libvips-cpp.8.18.7.dylib",
    ]);
  });

  test("PowerShell's modules of one live process, found by its id", () => {
    const script = modulesScript(4242);
    expect(script).toMatch(/^\(Get-Process -Id 4242\)\.Modules \| Where-Object /);
    expect(script).toContain("Select-Object FileName");
    // Windows PowerShell 5.1 exits 1 when Get-Process -Name matches nothing.
    expect(script).not.toContain("-Name");
  });
});

describe("PowerShell", () => {
  test("runs one pipeline encoded, quiet, in UTF-8, with its output as JSON", () => {
    const [command, args] = powershellCommand("Get-Item 'C:\\x y'");
    expect(command).toBe("powershell.exe");
    expect(args.slice(0, 5)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    const script = Buffer.from(args[5] as string, "base64").toString("utf16le");
    expect(script.split("\n")).toEqual([
      '$ProgressPreference = "SilentlyContinue"',
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      "Get-Item 'C:\\x y' | ConvertTo-Json -Compress -Depth 4",
    ]);
  });

  test("its JSON as a list, whether it printed nothing, one object bare, or several", () => {
    expect(jsonList("")).toEqual([]);
    expect(jsonList("\r\n")).toEqual([]);
    expect(jsonList('\uFEFF{"FileName":"C:\\\\a.dll"}\r\n')).toEqual([{ FileName: "C:\\a.dll" }]);
    expect(jsonList('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("the files the smoke reads", () => {
  test("the photo is a 4×2 JPEG with EXIF; a bare one reads without", () => {
    expect(jpegFacts(Buffer.from(ROTATED_PHOTO, "base64"))).toEqual({
      width: 4,
      height: 2,
      exif: true,
    });
    // SOI, SOF0 for 2×4, SOS, EOI.
    const bare = Buffer.from(
      "ffd8ffc0001108000400020301220002110103110100ffda0008010100003f00ffd9",
      "hex",
    );
    expect(jpegFacts(bare)).toEqual({ width: 2, height: 4, exif: false });
    expect(jpegFacts(Buffer.from("89504e470d0a1a0a", "hex"))).toBeNull();
  });

  test("the tray icon is an .ico with images; anything else holds none", () => {
    const icon = readFileSync(join(import.meta.dirname, "..", "assets", "tray-icon.ico"));
    expect(icoImages(icon)).toBeGreaterThan(0);
    expect(icoImages(Buffer.from("00000100", "hex"))).toBe(0);
    expect(icoImages(Buffer.from("000001000100", "hex"))).toBe(0);
    expect(icoImages(Buffer.from("89504e470d0a1a0a", "hex"))).toBe(0);
  });

  test("main.log's timestamps as epoch ms, in local time", () => {
    const at = lineTime("[2026-11-21 12:16:20.083] [info]  Eidolon: the backend listens on x");
    expect(at).toBe(new Date(2026, 10, 21, 12, 16, 20, 83).getTime());
    expect(lineTime("no stamp")).toBeNull();
  });
});

describe("the logs", () => {
  const stamp = "[2026-11-21 12:35:21.804]";
  const logged = `${stamp} 2026-11-21T20:35:21.800Z |`;

  test("backend.log's JavaScript errors outside its logger's lines, not its warnings", () => {
    const opened = [
      `${stamp} Error: Could not load the "sharp" module using the darwin-arm64 runtime`,
      `${stamp} TypeError: Cannot read properties of undefined (reading 'id')`,
      `${stamp} Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'`,
      `${stamp} [Error: no stack]`,
      `${stamp} Uncaught Error: thrown`,
      `${stamp} node:internal/process/promises:394`,
      `${stamp} [UnhandledPromiseRejection: This error originated either by throwing inside of an async function]`,
    ];
    const text = [
      `${logged} INFO     | Bot server listening on http://127.0.0.1:62688/`,
      `${logged} ERROR    | POST /api/local/chats/x/files failed (error 98cd3ba3)`,
      ...opened,
      `${stamp}     at ModuleJob.run (node:internal/modules/esm/module_job:561:25)`,
      `${stamp} (node:4242) ExperimentalWarning: SQLite is an experimental feature`,
      `${stamp} Errors: 0`,
      "",
    ].join("\r\n");
    expect(strayErrorLines(text)).toEqual(opened);
  });

  test("where a log gives away a link code's line or the token, never what it gave", () => {
    const token = "s3cr3t-token-43-characters-of-base64url-xyz";
    const text = [
      `${stamp} [info]  Eidolon: the backend listens on http://127.0.0.1:62688`,
      `${stamp} Eidolon is ready: http://127.0.0.1:62688/#link`,
      `${stamp} the token is ${token}`,
    ].join("\n");
    expect(leaks(text, token)).toEqual([
      "line 2 holds a link code's line",
      "line 3 holds the token",
    ]);
    expect(leaks(text.split("\n")[0] as string, token)).toEqual([]);
  });
});

describe("processes naming the run's folder", () => {
  test("none off macOS", async () => {
    expect(await processesNaming("anything", "win32")).toEqual([]);
  });

  test.skipIf(process.platform !== "darwin")(
    "on macOS, by their environment as well as their command line",
    async () => {
      const marker = `eidolon-smoke-packaged-${process.pid}-${Date.now()}`;
      const idle = ["-e", "setTimeout(() => {}, 30000)"];
      // Node, not /bin/sleep: macOS shows no other process the environment of Apple's own binaries.
      const named = spawn(process.execPath, idle, { env: { ...process.env, MARKED: marker } });
      const other = spawn(process.execPath, idle);
      try {
        await Promise.all([once(named, "spawn"), once(other, "spawn")]);
        const found = await processesNaming(marker);
        expect(found.map((row) => row.pid)).toEqual([named.pid]);
        expect(found[0]?.command).toBe(`${process.execPath} -e setTimeout(() => {}, 30000)`);
      } finally {
        named.kill("SIGKILL");
        other.kill("SIGKILL");
      }
    },
  );
});

describe("a folder's files by hash", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eidolon-smoke-packaged-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("name each file under it by its path, size and content", () => {
    writeFileSync(join(dir, "local-token"), "secret\n");
    mkdtempSync(join(dir, "locks-"));
    const before = fileHashes(dir);
    expect(Object.keys(before ?? {})).toEqual(["local-token"]);
    expect(before?.["local-token"]).toMatch(/^7 [0-9a-f]{64}$/);
    expect(fileHashes(join(dir, "missing"))).toBeNull();
  });

  test("tell what changed, came or went, and a folder that came or went", () => {
    writeFileSync(join(dir, "a"), "1");
    writeFileSync(join(dir, "b"), "2");
    const before = fileHashes(dir);
    expect(changedFiles(before, fileHashes(dir))).toEqual([]);
    writeFileSync(join(dir, "a"), "3");
    unlinkSync(join(dir, "b"));
    writeFileSync(join(dir, "c"), "4");
    expect(changedFiles(before, fileHashes(dir))).toEqual(["a", "b", "c"]);
    expect(changedFiles(before, null)).toEqual(["the folder is gone"]);
    expect(changedFiles(null, before)).toEqual(["the folder appeared"]);
  });
});

describe("the NSIS setup's uninstall", () => {
  const entry = {
    DisplayName: "Eidolon 0.0.0-dev",
    DisplayVersion: "0.0.0-dev",
    UninstallString: `"${WIN_UNINSTALLER}" /currentuser`,
  };

  test("lists this user's Eidolon entries from HKCU's uninstall key", () => {
    expect(UNINSTALL_KEY).toBe("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall");
    expect(ENTRIES_SCRIPT).toBe(
      "Get-ChildItem -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -like 'Eidolon*' } | Select-Object DisplayName,DisplayVersion,UninstallString",
    );
  });

  test("an entry names the install folder's uninstaller, for this user", () => {
    expect(namesUninstaller(entry, WIN_FOLDER)).toBe(true);
    expect(namesUninstaller(entry, WIN_FOLDER.toUpperCase())).toBe(true);
    expect(
      namesUninstaller({ ...entry, UninstallString: `"${WIN_UNINSTALLER}"` }, WIN_FOLDER),
    ).toBe(false);
    expect(namesUninstaller(entry, "C:\\Program Files\\Eidolon")).toBe(false);
    expect(namesUninstaller({}, WIN_FOLDER)).toBe(false);
  });

  test("runs silently: the entry's command with /S, else the folder's uninstaller for this user", () => {
    expect(silentUninstall(entry, WIN_FOLDER)).toEqual({
      command: WIN_UNINSTALLER,
      args: ["/currentuser", "/S"],
    });
    expect(silentUninstall(undefined, WIN_FOLDER)).toEqual({
      command: WIN_UNINSTALLER,
      args: ["/currentuser", "/S"],
    });
  });
});
