import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import afterPack, { rewriteAppBundleUuids } from "../scripts/after-pack.ts";
import {
  deriveMachoUuid,
  formatUuid,
  LC_UUID,
  LC_UUID_CMDSIZE,
  MH_EXECUTE,
  MH_MAGIC_64,
  readMachoExecuteUuid,
  rewriteMachoExecuteUuid,
  STOCK_LLD_UUID_PREFIX,
} from "../scripts/macho.ts";
import { macBundleLocalNetworkChecks, parseAppleXmlPlist } from "../scripts/signed-check.ts";

const DESKTOP = resolve(import.meta.dirname, "..");
const PACKAGED_APP = join(DESKTOP, ".out", "mac-arm64", "LAPLACE Eidolon.app");
const REQUIRE_PACKAGED = process.env.EIDOLON_REQUIRE_STAGE === "1";

function packagedAppIsCurrent(): boolean {
  if (process.platform !== "darwin" || !existsSync(PACKAGED_APP)) return false;
  if (REQUIRE_PACKAGED) return true;
  const appMtime = statSync(PACKAGED_APP).mtimeMs;
  return [
    join(DESKTOP, "electron-builder.yml"),
    join(DESKTOP, "scripts", "after-pack.ts"),
    join(DESKTOP, "scripts", "macho.ts"),
  ].every((source) => appMtime >= statSync(source).mtimeMs);
}

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Builds a minimal 64-bit Mach-O binary buffer with a single LC_UUID load command. */
function makeMachoBinary(filetype: number, uuidBytes: Uint8Array): Buffer {
  const buf = Buffer.alloc(32 + LC_UUID_CMDSIZE);
  buf.writeUInt32LE(MH_MAGIC_64, 0);
  buf.writeUInt32LE(filetype, 12);
  buf.writeUInt32LE(1, 16);
  buf.writeUInt32LE(LC_UUID_CMDSIZE, 20);
  buf.writeUInt32LE(LC_UUID, 32);
  buf.writeUInt32LE(LC_UUID_CMDSIZE, 36);
  Buffer.from(uuidBytes).copy(buf, 40);
  return buf;
}

function makePlistXml(entries: Record<string, string>): string {
  const rows = Object.entries(entries)
    .map(([k, v]) => `  <key>${k}</key>\n  <string>${v}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${rows}
</dict>
</plist>
`;
}

describe("Mach-O LC_UUID helpers and desktop afterPack hook", () => {
  test("deriveMachoUuid produces deterministic RFC 9562 UUIDv8 buffers distinct from stock lld UUIDs", () => {
    const a1 = deriveMachoUuid("live.laplace.eidolon@0.9.0+electron-45.5.0:main");
    const a2 = deriveMachoUuid("live.laplace.eidolon@0.9.0+electron-45.5.0:main");
    const b = deriveMachoUuid("live.laplace.eidolon.helper@0.9.0+electron-45.5.0:Helper.app");
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect(a1.length).toBe(16);
    expect((a1[6]! & 0xf0) >> 4).toBe(8);
    expect((a1[8]! & 0xc0) >> 6).toBe(2);
    expect(formatUuid(a1).startsWith(STOCK_LLD_UUID_PREFIX)).toBe(false);
    expect(formatUuid(b).startsWith(STOCK_LLD_UUID_PREFIX)).toBe(false);
  });

  test("readMachoExecuteUuid returns null when LC_UUID is absent and rewriteMachoExecuteUuid handles non-execute or missing-UUID binaries", () => {
    const stockBytes = Buffer.from("4c4c448e55553144a14cbbd02afa9f74", "hex");
    const exeBuf = makeMachoBinary(MH_EXECUTE, stockBytes);
    const dylibBuf = makeMachoBinary(6, stockBytes);
    const missingUuidExe = Buffer.alloc(32);
    missingUuidExe.writeUInt32LE(MH_MAGIC_64, 0);
    missingUuidExe.writeUInt32LE(MH_EXECUTE, 12);

    expect(readMachoExecuteUuid(exeBuf)).toBe("4c4c448e-5555-3144-a14c-bbd02afa9f74");
    expect(readMachoExecuteUuid(dylibBuf)).toBeNull();
    expect(readMachoExecuteUuid(missingUuidExe)).toBeNull();

    const dir = tempDir("eidolon-macho-");
    const exeFile = join(dir, "main");
    const dylibFile = join(dir, "framework");
    const noUuidFile = join(dir, "no-uuid");
    writeFileSync(exeFile, exeBuf);
    writeFileSync(dylibFile, dylibBuf);
    writeFileSync(noUuidFile, missingUuidExe);

    const nextUuid = deriveMachoUuid("test-exe");
    rewriteMachoExecuteUuid(exeFile, nextUuid);
    expect(readMachoExecuteUuid(exeFile)).toBe(formatUuid(nextUuid));
    expect(() => rewriteMachoExecuteUuid(dylibFile, nextUuid)).toThrow(/not a 64-bit MH_EXECUTE/);
    expect(() => rewriteMachoExecuteUuid(noUuidFile, nextUuid)).toThrow(/No LC_UUID load command/);
  });

  test("rewriteAppBundleUuids rewrites main and helper executables, leaves .framework intact, and no-ops off darwin", async () => {
    const outDir = tempDir("eidolon-afterpack-");
    const appDir = join(outDir, "LAPLACE Eidolon.app");
    const stockMain = Buffer.from("4c4c448e55553144a14cbbd02afa9f74", "hex");
    const stockHelper = Buffer.from("4c4c44fc55553144a1cc4099d5d7bde1", "hex");
    const stockFramework = Buffer.from("4c4c449555531440a1e4e0adb297ab1c", "hex");

    mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      join(appDir, "Contents", "Info.plist"),
      makePlistXml({
        CFBundleIdentifier: "live.laplace.eidolon",
        CFBundleShortVersionString: "0.9.0",
        CFBundleExecutable: "LAPLACE Eidolon",
        NSLocalNetworkUsageDescription: "Local network access for Subspace",
      }),
    );
    const mainExe = join(appDir, "Contents", "MacOS", "LAPLACE Eidolon");
    writeFileSync(mainExe, makeMachoBinary(MH_EXECUTE, stockMain));

    for (const suffix of ["", " (GPU)", " (Renderer)"]) {
      const appName = `LAPLACE Eidolon Helper${suffix}.app`;
      const exeName = `LAPLACE Eidolon Helper${suffix}`;
      const helperDir = join(appDir, "Contents", "Frameworks", appName, "Contents");
      mkdirSync(join(helperDir, "MacOS"), { recursive: true });
      writeFileSync(
        join(helperDir, "Info.plist"),
        makePlistXml({
          CFBundleIdentifier: `live.laplace.eidolon.helper${suffix.toLowerCase().replace(/[^a-z]/g, "")}`,
          CFBundleExecutable: exeName,
        }),
      );
      writeFileSync(join(helperDir, "MacOS", exeName), makeMachoBinary(MH_EXECUTE, stockHelper));
    }

    const fwDir = join(
      appDir,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
    );
    mkdirSync(fwDir, { recursive: true });
    const fwBin = join(fwDir, "Electron Framework");
    const fwOrig = makeMachoBinary(6, stockFramework);
    writeFileSync(fwBin, fwOrig);

    // No-op when electronPlatformName is not darwin.
    await afterPack({
      electronPlatformName: "win32",
      appOutDir: outDir,
      packager: {
        appInfo: { productFilename: "LAPLACE Eidolon" },
        config: { electronVersion: "45.5.0" },
      },
    });
    expect(readMachoExecuteUuid(mainExe)).toBe(formatUuid(stockMain));

    const map = rewriteAppBundleUuids(appDir, "45.5.0");
    expect(map.size).toBe(4);
    expect(new Set(map.values()).size).toBe(4);
    for (const uuid of map.values()) {
      expect(uuid.startsWith(STOCK_LLD_UUID_PREFIX)).toBe(false);
    }
    expect(readFileSync(fwBin)).toEqual(fwOrig);

    // Full darwin afterPack call re-derives the same deterministic UUIDs.
    await afterPack({
      electronPlatformName: "darwin",
      appOutDir: outDir,
      packager: {
        appInfo: { productFilename: "LAPLACE Eidolon" },
        config: { electronVersion: "45.5.0" },
      },
    });
    expect(readMachoExecuteUuid(mainExe)).toBe(
      map.get(join("Contents", "MacOS", "LAPLACE Eidolon")),
    );
  });

  test.skipIf(!packagedAppIsCurrent())(
    "packaged macOS app carries NSLocalNetworkUsageDescription and 5 unique non-stock Mach-O UUIDs",
    () => {
      const mainPlist = parseAppleXmlPlist(
        readFileSync(join(PACKAGED_APP, "Contents", "Info.plist"), "utf8"),
      ) as Record<string, unknown>;
      expect(typeof mainPlist.NSLocalNetworkUsageDescription).toBe("string");

      const uuids = new Map<string, string | null>();
      const mainExe = String(mainPlist.CFBundleExecutable);
      uuids.set(
        join("Contents", "MacOS", mainExe),
        readMachoExecuteUuid(join(PACKAGED_APP, "Contents", "MacOS", mainExe)),
      );
      for (const helper of ["Helper", "Helper (GPU)", "Helper (Plugin)", "Helper (Renderer)"]) {
        const rel = join(
          "Contents",
          "Frameworks",
          `LAPLACE Eidolon ${helper}.app`,
          "Contents",
          "MacOS",
          `LAPLACE Eidolon ${helper}`,
        );
        uuids.set(rel, readMachoExecuteUuid(join(PACKAGED_APP, rel)));
      }
      expect(uuids.size).toBe(5);
      const checks = macBundleLocalNetworkChecks(mainPlist, uuids);
      expect(checks.every((check) => check.pass)).toBe(true);
    },
  );
});
