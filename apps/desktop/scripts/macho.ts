// Reads and rewrites the Mach-O LC_UUID on 64-bit MH_EXECUTE binaries so macOS Local Network
// Privacy tracks each packaged Electron app and its helpers distinctly from stock Electron builds.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";

export const MH_MAGIC_64 = 0xfeedfacf;
export const MH_EXECUTE = 2;
export const LC_UUID = 0x1b;
export const LC_UUID_CMDSIZE = 24;
/** Prebuilt Electron binaries linked with lld carry LC_UUIDs starting with "4c4c44" ("LLD"). */
export const STOCK_LLD_UUID_PREFIX = "4c4c44";

interface Source {
  readonly size: number;
  read(offset: number, length: number): Buffer;
}

function bufferSource(buffer: Buffer): Source {
  return {
    size: buffer.length,
    read(offset, length) {
      if (offset < 0 || offset + length > buffer.length) throw new RangeError("read past the end");
      return buffer.subarray(offset, offset + length);
    },
  };
}

function fdSource(fd: number, size: number, file: string): Source {
  return {
    size,
    read(offset, length) {
      if (offset < 0 || offset + length > size) {
        throw new RangeError(`read past the end of ${file}`);
      }
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new RangeError(`short read in ${file}: expected ${length}, got ${bytesRead}`);
      }
      return buffer;
    },
  };
}

/** Derives a deterministic 16-byte RFC 9562 UUIDv8 for a Mach-O executable from `seed`. */
export function deriveMachoUuid(seed: string): Buffer {
  const hash = createHash("sha256").update(`eidolon-macho-uuid:${seed}`, "utf8").digest();
  const uuid = Buffer.from(hash.subarray(0, 16));
  if (uuid[0] === 0x4c && uuid[1] === 0x4c && uuid[2] === 0x44) uuid[0] ^= 0x01;
  uuid[6] = (uuid[6]! & 0x0f) | 0x80;
  uuid[8] = (uuid[8]! & 0x3f) | 0x80;
  return uuid;
}

/** Formats a 16-byte UUID buffer as a lowercase hyphenated string. */
export function formatUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error(`Expected 16 UUID bytes, got ${bytes.length}`);
  }
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type LocateResult =
  | { readonly kind: "not-execute" }
  | { readonly kind: "missing-uuid" }
  | { readonly kind: "ok"; readonly offset: number };

function locateExecuteUuidOffset(source: Source, label: string): LocateResult {
  if (source.size < 32) return { kind: "not-execute" };
  const header = source.read(0, 32);
  const magic = header.readUInt32LE(0);
  const filetype = header.readUInt32LE(12);
  if (magic !== MH_MAGIC_64 || filetype !== MH_EXECUTE) return { kind: "not-execute" };
  const ncmds = header.readUInt32LE(16);
  const sizeofcmds = header.readUInt32LE(20);
  if (32 + sizeofcmds > source.size) {
    throw new RangeError(`Mach-O load commands run past the end of ${label}`);
  }
  const cmds = source.read(32, sizeofcmds);
  let off = 0;
  for (let i = 0; i < ncmds; i++) {
    if (off + 8 > sizeofcmds) {
      throw new RangeError(`Truncated Mach-O load command in ${label}`);
    }
    const cmd = cmds.readUInt32LE(off);
    const cmdsize = cmds.readUInt32LE(off + 4);
    if (cmdsize < 8 || off + cmdsize > sizeofcmds) {
      throw new RangeError(`Invalid Mach-O load command size in ${label}`);
    }
    if (cmd === LC_UUID && cmdsize === LC_UUID_CMDSIZE) {
      return { kind: "ok", offset: 32 + off + 8 };
    }
    off += cmdsize;
  }
  return { kind: "missing-uuid" };
}

function withFileSource<T>(
  file: string,
  flags: "r" | "r+",
  fn: (source: Source, fd: number) => T,
): T {
  const fd = openSync(file, flags);
  try {
    return fn(fdSource(fd, fstatSync(fd).size, file), fd);
  } finally {
    closeSync(fd);
  }
}

function readUuidFromSource(source: Source, label: string): string | null {
  const located = locateExecuteUuidOffset(source, label);
  return located.kind === "ok" ? formatUuid(source.read(located.offset, 16)) : null;
}

/** Returns the lowercase UUID string of a 64-bit MH_EXECUTE Mach-O binary, or null otherwise. */
export function readMachoExecuteUuid(file: string | Buffer): string | null {
  if (Buffer.isBuffer(file)) return readUuidFromSource(bufferSource(file), "<buffer>");
  return withFileSource(file, "r", (source) => readUuidFromSource(source, file));
}

/** Overwrites the 16-byte LC_UUID payload in-place on a 64-bit MH_EXECUTE Mach-O binary. */
export function rewriteMachoExecuteUuid(file: string, uuid: Buffer): void {
  if (uuid.length !== 16) {
    throw new Error(`Expected 16 UUID bytes, got ${uuid.length}`);
  }
  withFileSource(file, "r+", (source, fd) => {
    const located = locateExecuteUuidOffset(source, file);
    if (located.kind === "not-execute") {
      throw new Error(`${file} is not a 64-bit MH_EXECUTE Mach-O binary`);
    }
    if (located.kind === "missing-uuid") {
      throw new Error(`No LC_UUID load command in ${file}`);
    }
    const written = writeSync(fd, uuid, 0, 16, located.offset);
    if (written !== 16) {
      throw new Error(`Failed to write full LC_UUID to ${file}: wrote ${written} bytes`);
    }
  });
}
