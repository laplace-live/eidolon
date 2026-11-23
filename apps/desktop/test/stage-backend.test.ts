// stage-backend's parts, on made-up lockfiles, folders, PE files and zips: the pinning to bun.lock,
// what is pruned, where the VC++ runtime goes, the unsigned-PE list and the license texts. The
// staged payload itself is stage.test.ts's.
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { packageManifest } from "../../eidolon/scripts/build.ts";
import {
  type BunLock,
  type LsNode,
  lockDrift,
  lockedTree,
  type Overrides,
  parseBunLock,
  pinOverrides,
  readBunLock,
  resolveFrom,
  supports,
} from "../scripts/lockfile.ts";
import { NODE_SHIM } from "../scripts/node-shim.ts";
import { compareVersions, readPe } from "../scripts/pe.ts";
import {
  dropUnpacked,
  newestVcRedist,
  parseTarget,
  peFilesIn,
  peFilesInZip,
  pruneOnnxruntime,
  stageBackend,
  stageDir,
  thirdPartyLicenses,
  unsignedNames,
  vcRuntimeNeeds,
} from "../scripts/stage-backend.ts";

const ROOT = join(import.meta.dirname, "../../..");
const VC = [
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_atomic_wait.dll",
];

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-stage-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(file: string, content: string | Buffer = ""): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

interface PeSpec {
  readonly linker?: string;
  readonly imports?: readonly string[];
  readonly delayImports?: readonly string[];
  /** A certificate table of zeros, which says nothing of its signer. */
  readonly signed?: boolean;
  /** The certificate table, as `authenticode()` writes one. */
  readonly certificate?: Buffer;
  readonly fileVersion?: readonly [number, number, number, number];
}

/** A DER element of `tag` holding `content`. */
function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const size = body.length;
  const length =
    size < 0x80
      ? Buffer.of(size)
      : size < 0x100
        ? Buffer.of(0x81, size)
        : Buffer.of(0x82, size >> 8, size & 0xff);
  return Buffer.concat([Buffer.of(tag), length, body]);
}
const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;

/** An X.501 Name: an organization, then the common name, a UTF8String unless `tag` says. */
function name(commonName: string, tag = 0x0c): Buffer {
  const text =
    tag === 0x1e ? Buffer.from(commonName, "utf16le").swap16() : Buffer.from(commonName, "utf8");
  const attribute = (oid: number, value: Buffer) =>
    der(SET, der(SEQUENCE, der(0x06, Buffer.of(0x55, 0x04, oid)), value));
  return der(
    SEQUENCE,
    attribute(10, der(0x13, Buffer.from("Microsoft Corporation"))),
    attribute(3, der(tag, text)),
  );
}

/** As much of an X.509 certificate as names it: its version, serial, issuer and subject. */
function certificate(serial: number, issuer: Buffer, subject: Buffer): Buffer {
  const tbs = der(
    SEQUENCE,
    der(0xa0, der(INTEGER, Buffer.of(2))),
    der(INTEGER, Buffer.of(serial)),
    der(SEQUENCE),
    issuer,
    der(SEQUENCE),
    subject,
    der(SEQUENCE),
  );
  return der(SEQUENCE, tbs, der(SEQUENCE), der(0x03, Buffer.of(0)));
}

/**
 * A WIN_CERTIFICATE whose PKCS#7 SignedData holds `certificates` and names its signer's; with
 * `indefinite`, the SignedData in BER's indefinite length, ended by two zero octets.
 */
function authenticode(
  certificates: readonly Buffer[],
  issuer: Buffer,
  serial: number,
  indefinite = false,
): Buffer {
  const signerInfo = der(
    SEQUENCE,
    der(INTEGER, Buffer.of(1)),
    der(SEQUENCE, issuer, der(INTEGER, Buffer.of(serial))),
    der(SEQUENCE),
    der(SEQUENCE),
    der(0x04),
  );
  const fields = [
    der(INTEGER, Buffer.of(1)),
    der(SET),
    der(SEQUENCE),
    der(0xa0, ...certificates),
    der(SET, signerInfo),
  ];
  const signedData = indefinite
    ? Buffer.concat([Buffer.of(SEQUENCE, 0x80), ...fields, Buffer.of(0, 0)])
    : der(SEQUENCE, ...fields);
  // 1.2.840.113549.1.7.2, signedData.
  const signedDataOid = Buffer.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02);
  const pkcs7 = der(SEQUENCE, der(0x06, signedDataOid), der(0xa0, signedData));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(8 + pkcs7.length, 0);
  header.writeUInt16LE(0x0200, 4);
  header.writeUInt16LE(2, 6);
  return Buffer.concat([header, pkcs7, Buffer.alloc((8 - (pkcs7.length % 8)) % 8)]);
}

/** A signature by `signer`, whose certificate follows its issuer's, as d3dcompiler_47.dll's does. */
function signedBy(signer: string, tag?: number): Buffer {
  const pca = name("Microsoft Code Signing PCA 2024");
  const root = name("Microsoft Root Certificate Authority 2011");
  // The intermediate shares the signer's serial number, under another issuer.
  return authenticode([certificate(7, root, pca), certificate(7, pca, name(signer, tag))], pca, 7);
}

/** A PE32+ image with one section holding its import tables and version resource. */
function pe(spec: PeSpec = {}): Buffer {
  const rvaBase = 0x1000;
  const rawAt = 0x200;
  const body = Buffer.alloc(0x800);
  let used = 0;
  const alloc = (size: number) => {
    const at = used;
    used += Math.ceil(size / 8) * 8;
    return at;
  };
  const string = (text: string) => {
    const at = alloc(text.length + 1);
    body.write(text, at, "latin1");
    return rvaBase + at;
  };
  const imports = spec.imports ?? [];
  const importsAt = alloc((imports.length + 1) * 20);
  for (const [i, name] of imports.entries()) {
    body.writeUInt32LE(string(name), importsAt + i * 20 + 12);
  }
  const delays = spec.delayImports ?? [];
  const delaysAt = alloc((delays.length + 1) * 32);
  for (const [i, name] of delays.entries()) {
    body.writeUInt32LE(1, delaysAt + i * 32);
    body.writeUInt32LE(string(name), delaysAt + i * 32 + 4);
  }
  const resources = alloc(180);
  if (spec.fileVersion !== undefined) {
    // Type RT_VERSION, then name 1, then language 0x409, each one entry, then the data entry.
    const level = (at: number, id: number, target: number) => {
      body.writeUInt16LE(1, resources + at + 14);
      body.writeUInt32LE(id, resources + at + 16);
      body.writeUInt32LE(target, resources + at + 20);
    };
    level(0, 16, 0x80000000 + 24);
    level(24, 1, 0x80000000 + 48);
    level(48, 0x409, 72);
    const info = resources + 88;
    body.writeUInt32LE(rvaBase + info, resources + 72);
    body.writeUInt32LE(92, resources + 76);
    body.writeUInt16LE(92, info);
    body.writeUInt16LE(52, info + 2);
    body.write("VS_VERSION_INFO", info + 6, "utf16le");
    const [a, b, c, d] = spec.fileVersion;
    body.writeUInt32LE(0xfeef04bd, info + 40);
    body.writeUInt32LE(((a << 16) | b) >>> 0, info + 48);
    body.writeUInt32LE(((c << 16) | d) >>> 0, info + 52);
  }
  const certificates = spec.certificate ?? Buffer.alloc(spec.signed ? 16 : 0);
  const file = Buffer.alloc(rawAt + body.length + certificates.length);
  file.write("MZ", 0, "latin1");
  file.writeUInt32LE(0x40, 0x3c);
  file.write("PE\0\0", 0x40, "latin1");
  file.writeUInt16LE(0x8664, 0x44);
  file.writeUInt16LE(1, 0x46);
  file.writeUInt16LE(240, 0x54);
  const optional = 0x58;
  file.writeUInt16LE(0x20b, optional);
  const [major, minor] = (spec.linker ?? "14.44").split(".").map(Number) as [number, number];
  file.writeUInt8(major, optional + 2);
  file.writeUInt8(minor, optional + 3);
  file.writeUInt32LE(16, optional + 108);
  const directory = (index: number, address: number, size: number) => {
    file.writeUInt32LE(address, optional + 112 + index * 8);
    file.writeUInt32LE(size, optional + 116 + index * 8);
  };
  if (imports.length > 0) directory(1, rvaBase + importsAt, (imports.length + 1) * 20);
  if (spec.fileVersion !== undefined) directory(2, rvaBase + resources, 16);
  if (certificates.length > 0) directory(4, rawAt + body.length, certificates.length);
  if (delays.length > 0) directory(13, rvaBase + delaysAt, (delays.length + 1) * 32);
  const section = optional + 240;
  file.write(".data", section, "latin1");
  file.writeUInt32LE(body.length, section + 8);
  file.writeUInt32LE(rvaBase, section + 12);
  file.writeUInt32LE(body.length, section + 16);
  file.writeUInt32LE(rawAt, section + 20);
  body.copy(file, rawAt);
  certificates.copy(file, rawAt + body.length);
  return file;
}

/** A zip of `entries`, deflated or stored. */
function zip(entries: readonly { name: string; data: Buffer; deflate: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const body = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, body);
    directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const listing = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listing, end]);
}

// a nests its own b, which nests its own c; d takes the top-level b. One optional package is for
// macOS on Apple silicon, one for Windows x64, one for anything but Windows; q is an optional peer.
// bin-mac and bin-win are a manifest's own optional binaries, as LanceDB's are the payload's.
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "a, ] and } in a string", "dependencies": { "a": "1.0.0", }, }, },
  "packages": {
    "a": ["a@1.0.0", "", { "dependencies": { "b": "^1", "c": "^2", }, "optionalDependencies": { "mac-only": "1.0.0", "win-only": "1.0.0", }, "peerDependencies": { "p": "*", "q": "*", }, "optionalPeers": ["q",], }, "sha512-a"],
    "a/b": ["b@1.1.0", "", { "dependencies": { "c": "^1", }, }, "sha512-ab"],
    "a/b/c": ["c@1.0.0", "", {}, "sha512-abc"],
    "b": ["b@2.0.0", "", {}, "sha512-b"],
    "bin-mac": ["bin-mac@1.0.0", "", { "os": "darwin", "cpu": "arm64", }, "sha512-bm"],
    "bin-win": ["bin-win@1.0.0", "", { "os": "win32", "cpu": "x64", }, "sha512-bw"],
    "c": ["c@2.0.0", "", {}, "sha512-c"],
    "d": ["d@1.0.0", "", { "dependencies": { "b": "^2", }, "optionalDependencies": { "not-win": "1.0.0", }, }, "sha512-d"],
    "mac-only": ["mac-only@1.0.0", "", { "os": "darwin", "cpu": "arm64", }, "sha512-m"],
    "not-win": ["not-win@1.0.0", "", { "os": ["!win32",], }, "sha512-n"],
    "p": ["p@1.0.0", "", {}, "sha512-p"],
    "q": ["q@1.0.0", "", {}, "sha512-q"],
    "win-only": ["win-only@1.0.0", "", { "os": ["win32",], "cpu": ["x64",], }, "sha512-w"],
  },
}
`;
const ROOTS = { a: "1.0.0", d: "1.0.0" };
const DARWIN = { os: "darwin", cpu: "arm64" };
const WIN32 = { os: "win32", cpu: "x64" };

describe("bun.lock", () => {
  const lock: BunLock = parseBunLock(LOCK);

  test("reads its trailing commas as JSON, and leaves the ones inside strings", () => {
    expect(Object.keys(lock.packages)).toHaveLength(13);
    expect(parseBunLock(LOCK)).toMatchObject({
      workspaces: { "": { name: "a, ] and } in a string" } },
    });
    expect(parseBunLock('["a\\", ]",]')).toEqual(['a", ]']);
  });

  test("resolves a dependency from the nearest folder above, as Node does", () => {
    expect(resolveFrom(lock, ["a"], "b")?.version).toBe("1.1.0");
    expect(resolveFrom(lock, ["a", "b"], "c")?.version).toBe("1.0.0");
    expect(resolveFrom(lock, ["a"], "c")?.version).toBe("2.0.0");
    expect(resolveFrom(lock, ["d"], "b")?.version).toBe("2.0.0");
    expect(resolveFrom(lock, ["d"], "zzz")).toBeNull();
  });

  test("follows dependencies, required peers, and the optional ones a platform supports", () => {
    const keys = (platform?: { os: string; cpu: string }) =>
      [...lockedTree(lock, ROOTS, platform).keys()].sort();
    const always = ["a", "a/b", "a/b/c", "b", "c", "d", "p"];
    expect(keys()).toEqual([...always, "mac-only", "not-win", "win-only"].sort());
    expect(keys(DARWIN)).toEqual([...always, "mac-only", "not-win"].sort());
    expect(keys(WIN32)).toEqual([...always, "win-only"].sort());
    expect([
      supports(["!win32"], "linux"),
      supports("none", "x64"),
      supports(undefined, "x64"),
    ]).toEqual([true, false, true]);
  });

  test("refuses a root bun.lock has at another version", () => {
    expect(() => lockedTree(lock, { a: "1.0.1" })).toThrow(
      "bun.lock has a at 1.0.0, not 1.0.1: run bun install",
    );
  });

  test("pins each package where bun.lock puts it, nesting its second versions", () => {
    expect(pinOverrides(lockedTree(lock, ROOTS).values())).toEqual({
      a: { ".": "1.0.0", b: { ".": "1.1.0", c: "1.0.0" } },
      b: "2.0.0",
      c: "2.0.0",
      d: "1.0.0",
      "mac-only": "1.0.0",
      "not-win": "1.0.0",
      p: "1.0.0",
      "win-only": "1.0.0",
    });
  });

  test("pins every package the externals reach, those npx drifted on among them, and none of LanceDB's own", () => {
    const manifest = packageManifest();
    const tree = lockedTree(readBunLock(join(ROOT, "bun.lock")), {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    });
    const overrides = pinOverrides(tree.values());
    const pinned = (path: readonly string[]): string | undefined => {
      let at: string | Overrides | undefined = overrides;
      for (const name of path) at = typeof at === "object" ? at[name] : undefined;
      return typeof at === "object" ? (at["."] as string) : at;
    };
    for (const locked of tree.values()) {
      expect([locked.path.join("/"), pinned(locked.path)]).toEqual([
        locked.path.join("/"),
        locked.version,
      ]);
    }
    const names = new Set([...tree.values()].map((locked) => locked.name));
    for (const name of ["mediabunny", "global-agent", "@lancedb/lancedb-win32-x64-msvc"]) {
      expect([name, names.has(name)]).toEqual([name, true]);
    }
    for (const name of ["@lancedb/lancedb", "@huggingface/transformers", "openai"]) {
      expect([name, names.has(name)]).toEqual([name, false]);
    }
  });
});

describe("an install against bun.lock", () => {
  const lock = parseBunLock(LOCK);
  const darwin = (): LsNode => ({
    dependencies: {
      a: {
        version: "1.0.0",
        dependencies: {
          b: { version: "1.1.0", dependencies: { c: { version: "1.0.0" } } },
          c: { version: "2.0.0" },
          "mac-only": { version: "1.0.0" },
          "win-only": {},
          p: { version: "1.0.0" },
        },
      },
      d: {
        version: "1.0.0",
        dependencies: { b: { version: "2.0.0" }, "not-win": { version: "1.0.0" } },
      },
    },
  });

  test("agrees when npm installed bun.lock's tree, the platform's skips aside", () => {
    expect(lockDrift(darwin(), lock, ROOTS, DARWIN)).toEqual([]);
  });

  test("names a version npm resolved otherwise, what either side lacks, and npm's problems", () => {
    const ls = darwin() as { dependencies: Record<string, LsNode> };
    const a = ls.dependencies.a as { dependencies: Record<string, LsNode> };
    a.dependencies.b = { version: "1.1.0", dependencies: { c: { version: "1.0.1" } } };
    delete a.dependencies.p;
    ls.dependencies.d = {
      version: "1.0.0",
      dependencies: { b: { version: "2.0.0" }, x: { version: "9.0.0" }, "not-win": {} },
    };
    expect(lockDrift({ ...ls, problems: ["invalid: c@1.0.1"] }, lock, ROOTS, DARWIN)).toEqual([
      "invalid: c@1.0.1",
      "a > b > c: npm installed 1.0.1, bun.lock has 1.0.0",
      "d > x@9.0.0: not in bun.lock",
      "p@1.0.0 (p): not installed",
      "not-win@1.0.0 (not-win): not installed",
    ]);
    expect(lockDrift(darwin(), lock, { ...ROOTS, a: "1.0.1" }, DARWIN)).toEqual([
      "bun.lock has a at 1.0.0, not 1.0.1: run bun install",
    ]);
  });

  test("names the platform's own binary when npm skipped it, as it skips one it fails to fetch", () => {
    const roots = { ...ROOTS, "bin-mac": "1.0.0", "bin-win": "1.0.0" };
    const ls = (binary: LsNode): LsNode => ({
      dependencies: { ...darwin().dependencies, "bin-mac": binary, "bin-win": {} },
    });
    expect(lockDrift(ls({ version: "1.0.0" }), lock, roots, DARWIN)).toEqual([]);
    expect(lockDrift(ls({}), lock, roots, DARWIN)).toEqual([
      "bin-mac@1.0.0 (bin-mac): not installed",
    ]);
  });
});

describe("a PE file", () => {
  test("gives its linker, its imports, whether it is signed and its file version", () => {
    expect(
      readPe(
        pe({
          linker: "14.51",
          imports: ["VCRUNTIME140.dll", "KERNEL32.dll"],
          delayImports: ["DirectML.dll"],
          signed: true,
          fileVersion: [14, 52, 37029, 0],
        }),
      ),
    ).toEqual({
      linker: "14.51",
      signed: true,
      signer: null,
      imports: ["VCRUNTIME140.dll", "KERNEL32.dll"],
      delayImports: ["DirectML.dll"],
      fileVersion: "14.52.37029.0",
    });
    expect(readPe(pe())).toEqual({
      linker: "14.44",
      signed: false,
      signer: null,
      imports: [],
      delayImports: [],
      fileVersion: null,
    });
  });

  test("names its signer from the certificate its signature names, in any string type", () => {
    const signer = (certificate: Buffer) => readPe(pe({ certificate }))?.signer;
    expect(signer(signedBy("Microsoft Corporation"))).toBe("Microsoft Corporation");
    expect(signer(signedBy("Microsoft Windows", 0x13))).toBe("Microsoft Windows");
    expect(signer(signedBy("微软 Windows", 0x1e))).toBe("微软 Windows");
    expect(readPe(pe({ certificate: signedBy("LAPLACE Live LLC") }))).toMatchObject({
      signed: true,
      signer: "LAPLACE Live LLC",
    });
  });

  test("names no signer it can't find: none listed, a certificate it lacks, or no DER", () => {
    const pca = name("Microsoft Code Signing PCA 2024");
    const leaf = certificate(7, pca, name("Microsoft Corporation"));
    expect(readPe(pe({ certificate: authenticode([leaf], pca, 8) }))?.signer).toBeNull();
    expect(readPe(pe({ certificate: authenticode([], pca, 7) }))?.signer).toBeNull();
    // The same signature with its SignedData in BER's indefinite length, which DER forbids.
    expect(readPe(pe({ certificate: authenticode([leaf], pca, 7) }))?.signer).toBe(
      "Microsoft Corporation",
    );
    expect(readPe(pe({ certificate: authenticode([leaf], pca, 7, true) }))).toMatchObject({
      signed: true,
      signer: null,
    });
  });

  test("is read from disk the same, and anything else is no PE file", () => {
    const dir = temp();
    const file = put(join(dir, "x.dll"), pe({ imports: ["MSVCP140.dll"] }));
    expect(readPe(file)?.imports).toEqual(["MSVCP140.dll"]);
    expect(readPe(put(join(dir, "x.node"), "#!/usr/bin/env node\n".repeat(8)))).toBeNull();
    expect(readPe(Buffer.from("MZ"))).toBeNull();
  });

  test("versions compare part by part", () => {
    expect(compareVersions("14.52.37029.0", "14.51")).toBeGreaterThan(0);
    expect(compareVersions("14.44", "14.44.0")).toBe(0);
    expect(compareVersions("14.9", "14.10")).toBeLessThan(0);
  });
});

describe("onnxruntime-node", () => {
  const ORT = {
    "darwin/arm64": [
      "onnxruntime_binding.node",
      "libonnxruntime.1.dylib",
      "libonnxruntime.1.30.0.dylib",
    ],
    "linux/x64": ["onnxruntime_binding.node", "libonnxruntime.so.1"],
    "win32/x64": [
      "onnxruntime_binding.node",
      "onnxruntime.dll",
      "DirectML.dll",
      "dxcompiler.dll",
      "dxil.dll",
    ],
    "win32/arm64": ["onnxruntime_binding.node", "onnxruntime.dll"],
  };
  function modules(): string {
    const dir = temp();
    for (const [folder, names] of Object.entries(ORT)) {
      for (const name of names) put(join(dir, "onnxruntime-node", "bin", "napi-v6", folder, name));
    }
    put(join(dir, "onnxruntime-node", "dist", "index.js"));
    return dir;
  }
  const left = (dir: string) =>
    (readdirSync(join(dir, "onnxruntime-node"), { recursive: true }) as string[])
      .map((path) => path.split("\\").join("/"))
      .filter((path) => path.split("/").length === 5 || path.startsWith("dist"))
      .sort();

  test("keeps the target's binding and the library it loads, and nothing else", () => {
    const darwin = modules();
    pruneOnnxruntime(darwin, "darwin-arm64");
    expect(left(darwin)).toEqual([
      "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
      "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
      "dist",
      "dist/index.js",
    ]);
    const win32 = modules();
    pruneOnnxruntime(win32, "win32-x64");
    expect(left(win32)).toEqual([
      "bin/napi-v6/win32/x64/onnxruntime.dll",
      "bin/napi-v6/win32/x64/onnxruntime_binding.node",
      "dist",
      "dist/index.js",
    ]);
  });

  test("refuses a build that lacks them", () => {
    const dir = modules();
    rmSync(join(dir, "onnxruntime-node", "bin", "napi-v6", "win32", "x64", "onnxruntime.dll"));
    expect(() => pruneOnnxruntime(dir, "win32-x64")).toThrow(
      "onnxruntime-node has no onnxruntime.dll in win32/x64",
    );
  });
});

describe("what electron-builder never packs", () => {
  test("goes from the stage at any depth, and every other dotfile stays", () => {
    const payload = temp();
    const kept = [
      "node_modules/a/.gitattributes",
      "node_modules/a/.npmignore",
      "node_modules/a/index.js",
      "node-shim/node_modules/pnpm/dist/node_modules/undici/lib/llhttp/constants.js",
    ];
    for (const path of [
      ...kept,
      ".DS_Store",
      "node_modules/a/.gitkeep",
      "node-shim/node_modules/pnpm/dist/node_modules/undici/lib/llhttp/.gitkeep",
    ]) {
      put(join(payload, path));
    }
    dropUnpacked(payload);
    const files = (readdirSync(payload, { recursive: true, withFileTypes: true }) as Dirent[])
      .filter((entry) => entry.isFile())
      .map((entry) => relative(payload, join(entry.parentPath, entry.name)).split("\\").join("/"))
      .sort();
    expect(files).toEqual([...kept].sort());
  });
});

describe("the VC++ runtime", () => {
  function install(root: string, version: string, crt: string, names = VC): string {
    const dir = join(root, "VC", "Redist", "MSVC", version, "x64", crt);
    for (const name of names) put(join(dir, name), pe());
    return dir;
  }

  test("comes from the newest redist that has all five DLLs", () => {
    const vs2022 = temp();
    const vs2026 = temp();
    install(vs2022, "14.44.35112", "Microsoft.VC143.CRT");
    // Incomplete, older than 14.44 numerically, and not a version.
    install(vs2026, "14.50.35710", "Microsoft.VC145.CRT", VC.slice(0, 4));
    install(vs2026, "14.9.0", "Microsoft.VC145.CRT");
    install(vs2026, "v145", "Microsoft.VC145.CRT");
    expect(newestVcRedist([vs2022, vs2026]).dir).toBe(
      join(vs2022, "VC", "Redist", "MSVC", "14.44.35112", "x64", "Microsoft.VC143.CRT"),
    );
    const vs2027 = temp();
    install(vs2027, "14.52.37029", "Microsoft.VC145.CRT");
    expect(newestVcRedist([vs2022, vs2026, vs2027])).toEqual({
      version: "14.52.37029",
      dir: join(vs2027, "VC", "Redist", "MSVC", "14.52.37029", "x64", "Microsoft.VC145.CRT"),
    });
    expect(() => newestVcRedist([temp()])).toThrow("No Visual Studio redist with vcruntime140.dll");
  });

  test("goes beside each native in the payload that imports it, with what its DLLs import in turn", () => {
    const redist = temp();
    const runtimeImports: Record<string, string[]> = {
      "vcruntime140_1.dll": ["VCRUNTIME140.dll"],
      "msvcp140.dll": ["VCRUNTIME140.dll", "VCRUNTIME140_1.dll"],
      "msvcp140_1.dll": ["MSVCP140.dll"],
    };
    for (const name of VC) put(join(redist, name), pe({ imports: runtimeImports[name] ?? [] }));
    const payload = temp();
    const modules = join(payload, "node_modules");
    const ort = join(modules, "onnxruntime-node", "bin", "napi-v6", "win32", "x64");
    put(join(ort, "onnxruntime_binding.node"), pe({ imports: ["MSVCP140.dll"] }));
    put(
      join(ort, "onnxruntime.dll"),
      pe({ imports: ["MSVCP140_1.dll"], delayImports: ["MSVCP140_ATOMIC_WAIT.dll"] }),
    );
    const lancedb = join(modules, "@lancedb", "lancedb-win32-x64-msvc");
    put(join(lancedb, "lancedb.win32-x64-msvc.node"), pe({ imports: ["VCRUNTIME140.dll"] }));
    const sharp = join(modules, "@img", "sharp-win32-x64", "lib");
    put(join(sharp, "sharp-win32-x64.node"), pe({ imports: ["KERNEL32.dll"] }));
    put(join(sharp, "libvips-42.dll"), pe());
    // The node shim's pnpm's, which pnpm loads to clone a package into place; the UCRT is Windows'.
    const reflink = join(
      payload,
      NODE_SHIM,
      "node_modules",
      "pnpm",
      "dist",
      "node_modules",
      "@reflink",
      "reflink-win32-x64-msvc",
    );
    put(
      join(reflink, "reflink.win32-x64-msvc.node"),
      pe({ imports: ["VCRUNTIME140.dll", "api-ms-win-crt-heap-l1-1-0.dll"] }),
    );
    expect(vcRuntimeNeeds(payload, redist)).toEqual(
      new Map([
        [lancedb, ["vcruntime140.dll"]],
        [ort, [...VC].sort()],
        [reflink, ["vcruntime140.dll"]],
      ]),
    );
  });
});

describe("the unsigned-PE list", () => {
  test("names each unsigned .node and .dll in the payload once", () => {
    const payload = temp();
    put(join(payload, "node_modules", "a", "a.node"), pe());
    put(join(payload, "node_modules", "b", "b.dll"), pe({ signed: true }));
    put(join(payload, "node_modules", "c", "lib", "c.dll"), pe());
    put(join(payload, "node_modules", "d", "node_modules", "c", "lib", "c.dll"), pe());
    put(join(payload, "node_modules", "e", "e.exe"), pe());
    put(join(payload, "node_modules", "f", "f.dll"), "not a PE file");
    const pes = peFilesIn(payload);
    expect(pes.map(([name]) => name).sort()).toEqual(["a.node", "b.dll", "c.dll", "c.dll"]);
    expect(unsignedNames(pes)).toEqual(["a.node", "c.dll"]);
  });

  test("names Electron's DLLs as the app names them, with their signers", () => {
    const file = put(
      join(temp(), "electron-v45.4.1-win32-x64.zip"),
      zip([
        { name: "electron.exe", data: pe(), deflate: true },
        { name: "ffmpeg.dll", data: pe(), deflate: true },
        {
          name: "d3dcompiler_47.dll",
          data: pe({ certificate: signedBy("Microsoft Corporation") }),
          deflate: true,
        },
        { name: "electron_wer.dll", data: pe(), deflate: false },
        { name: "locales/en-US.pak", data: Buffer.from("pak"), deflate: true },
      ]),
    );
    const pes = peFilesInZip(file, "Eidolon");
    expect(pes.map(([name, { signer }]) => [name, signer])).toEqual([
      ["ffmpeg.dll", null],
      ["d3dcompiler_47.dll", "Microsoft Corporation"],
      ["Eidolon_wer.dll", null],
    ]);
    expect(unsignedNames(pes)).toEqual(["Eidolon_wer.dll", "ffmpeg.dll"]);
  });
});

describe("THIRD_PARTY_LICENSES.txt", () => {
  const LIBVIPS_SOURCE = "Its source is at https://github.com/libvips/libvips";
  const LGPL_TITLE = "GNU LESSER GENERAL PUBLIC LICENSE";

  /** A payload with what stage() writes beside node_modules: NOTICE, the notices and data/. */
  function payload(): string {
    const dir = temp();
    put(join(dir, "NOTICE"), "Eidolon\n\nNOTICE's own text\n");
    put(join(dir, "THIRD_PARTY_NOTICES.md"), "# Third-party notices\n\n### inlined 1.0.0 (MIT)\n");
    put(join(dir, "data", "jieba", "LICENSE"), "jieba's license\n");
    put(join(dir, "data", "jieba", "dict.txt"), "dict\n");
    put(join(dir, "data", "models", "THIRD_PARTY_LICENSES.md"), "the models' licenses\n");
    put(join(dir, "web", "assets", "notices-x.js"), "export {};\n");
    return dir;
  }
  function manifest(dir: string, fields: Record<string, string>): void {
    put(join(dir, "package.json"), JSON.stringify(fields));
  }
  /** Each section's title, and the text under it. */
  function sections(text: string): Map<string, string> {
    const parts = text.split(/^={78}\n(.+)\n={78}\n/m);
    const found = new Map<string, string>();
    for (let i = 1; i < parts.length; i += 2) {
      found.set(parts[i] as string, (parts[i + 1] as string).trim());
    }
    return found;
  }

  test("gives each package its own license, else SPDX's, then the payload's own notices", () => {
    const root = payload();
    const modules = join(root, "node_modules");
    manifest(join(modules, "own"), { name: "own", version: "1.0.0", license: "MIT" });
    put(join(modules, "own", "LICENSE.md"), "Copyright (c) Own\n");
    manifest(join(modules, "bare"), { name: "bare", version: "2.0.0", license: "Apache-2.0" });
    manifest(join(modules, "own", "node_modules", "bare"), {
      name: "bare",
      version: "1.0.0",
      license: "MIT",
    });
    put(join(modules, ".package-lock.json"), "{}");
    const text = thirdPartyLicenses(root, null);
    const found = sections(text);
    expect([...found.keys()]).toEqual([
      "bare 1.0.0 (MIT)",
      "bare 2.0.0 (Apache-2.0)",
      "own 1.0.0 (MIT)",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      "data/jieba/LICENSE",
      "data/models/THIRD_PARTY_LICENSES.md",
    ]);
    expect(found.get("own 1.0.0 (MIT)")).toBe("Copyright (c) Own");
    expect(found.get("bare 1.0.0 (MIT)")).toContain("Permission is hereby granted, free of charge");
    expect(found.get("bare 2.0.0 (Apache-2.0)")).toContain("Version 2.0, January 2004");
    expect(found.get("NOTICE")).toBe("Eidolon\n\nNOTICE's own text");
    expect(found.get("THIRD_PARTY_NOTICES.md")).toContain("### inlined 1.0.0 (MIT)");
    expect(found.get("data/models/THIRD_PARTY_LICENSES.md")).toBe("the models' licenses");
    expect(text).not.toContain(LIBVIPS_SOURCE);
    expect(text).not.toContain(LGPL_TITLE);
    expect(text).not.toContain("Visual C++");
  });

  test("gives the node shim's pnpm and each package its dist/ bundles theirs, SPDX's where they ship none", () => {
    const root = payload();
    const pnpm = join(root, "node-shim", "node_modules", "pnpm");
    manifest(pnpm, { name: "pnpm", version: "11.0.0", license: "MIT" });
    put(join(pnpm, "LICENSE"), "Copyright (c) pnpm contributors\n");
    const bundled = join(pnpm, "dist", "node_modules");
    manifest(join(bundled, "tar"), { name: "tar", version: "7.0.0", license: "BlueOak-1.0.0" });
    manifest(join(bundled, "@reflink", "reflink"), {
      name: "@reflink/reflink",
      version: "0.1.0",
      license: "MIT",
    });
    put(join(bundled, ".bin", "tar"));
    const found = sections(thirdPartyLicenses(root, null));
    expect([...found.keys()].slice(0, 3)).toEqual([
      "@reflink/reflink 0.1.0 (MIT)",
      "pnpm 11.0.0 (MIT)",
      "tar 7.0.0 (BlueOak-1.0.0)",
    ]);
    expect(found.get("pnpm 11.0.0 (MIT)")).toBe("Copyright (c) pnpm contributors");
    expect(found.get("tar 7.0.0 (BlueOak-1.0.0)")).toContain("Blue Oak Model License");
    expect(found.get("@reflink/reflink 0.1.0 (MIT)")).toContain("Permission is hereby granted");
  });

  test("says where libvips's source is and gives the LGPL, from its own package or sharp's", () => {
    const root = payload();
    const modules = join(root, "node_modules");
    // macOS: libvips in its own package, which ships no license file.
    const darwin = join(modules, "@img", "sharp-libvips-darwin-arm64");
    manifest(darwin, {
      name: "@img/sharp-libvips-darwin-arm64",
      version: "1.3.4",
      license: "LGPL-3.0-or-later",
    });
    put(join(darwin, "lib", "libvips-cpp.8.18.7.dylib"));
    put(join(darwin, "README.md"), "| glib | LGPLv3 |\n");
    // Windows: libvips inside sharp's own build, whose license file is the Apache half.
    const win32 = join(modules, "@img", "sharp-win32-x64");
    manifest(win32, {
      name: "@img/sharp-win32-x64",
      version: "0.35.5",
      license: "Apache-2.0 AND LGPL-3.0-or-later",
    });
    put(join(win32, "LICENSE"), "Apache License\nVersion 2.0, January 2004\n");
    put(join(win32, "lib", "libvips-42.dll"));
    put(join(win32, "lib", "libvips-cpp-8.18.7.dll"));
    put(join(win32, "lib", "sharp-win32-x64-0.35.5.node"));
    // sharp's JS names libvips too, but ships none of it.
    manifest(join(modules, "sharp"), { name: "sharp", version: "0.35.5", license: "Apache-2.0" });
    put(join(modules, "sharp", "dist", "libvips.cjs"));
    const found = sections(thirdPartyLicenses(root, null));
    for (const title of [
      "@img/sharp-libvips-darwin-arm64 1.3.4 (LGPL-3.0-or-later)",
      "@img/sharp-win32-x64 0.35.5 (Apache-2.0 AND LGPL-3.0-or-later)",
    ]) {
      const text = found.get(title) ?? "";
      for (const line of [LIBVIPS_SOURCE, "https://github.com/lovell/sharp-libvips", LGPL_TITLE]) {
        expect([title, line, text.includes(line)]).toEqual([title, line, true]);
      }
      expect(text.split(LGPL_TITLE)).toHaveLength(2);
    }
    expect(found.get("@img/sharp-libvips-darwin-arm64 1.3.4 (LGPL-3.0-or-later)")).toContain(
      "| glib | LGPLv3 |",
    );
    const win32Text = found.get("@img/sharp-win32-x64 0.35.5 (Apache-2.0 AND LGPL-3.0-or-later)");
    expect(win32Text).toContain(
      "Apache License\nVersion 2.0, January 2004\n\nThe package also declares LGPL-3.0-or-later",
    );
    expect(found.get("sharp 0.35.5 (Apache-2.0)")).not.toContain(LIBVIPS_SOURCE);
  });

  test("names the VC++ runtime on Windows, and the terms it ships under", () => {
    const text = thirdPartyLicenses(payload(), { version: "14.52.37029", dir: "C:\\redist" });
    expect(text).toContain("Microsoft Visual C++ runtime 14.52.37029\n");
    expect(text).toContain(`${VC.join(", ")}, beside the native modules that load them`);
    expect(text).toContain("the Visual Studio license terms");
  });
});

describe("staging", () => {
  test("is for darwin-arm64 and win32-x64", () => {
    expect([parseTarget("darwin-arm64"), parseTarget("win32-x64")]).toEqual([
      "darwin-arm64",
      "win32-x64",
    ]);
    expect(() => parseTarget("linux-x64")).toThrow(
      "The desktop app ships for darwin-arm64 and win32-x64, not linux-x64",
    );
  });

  test("refuses win32-x64 off Windows before touching any stage", async () => {
    const before = existsSync(stageDir("win32-x64"));
    await expect(stageBackend("win32-x64", { platform: "darwin" })).rejects.toThrow(
      "win32-x64 can only be staged on Windows: its natives get the VC++ runtime copied beside " +
        "them from this machine's Visual Studio redistributable",
    );
    expect(existsSync(stageDir("win32-x64"))).toBe(before);
  });
});
