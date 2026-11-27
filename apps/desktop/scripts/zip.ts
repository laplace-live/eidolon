// Reads the files of a zip, as the stage's signing lists need Electron's own zips, the ones
// electron-builder packs: stored and deflated entries, no ZIP64. https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { constants, inflateRawSync } from "node:zlib";

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
/** The end record's size plus the longest comment it may carry. */
const END_SEARCH = 22 + 0xffff;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly headerAt: number;
  readonly symlink: boolean;
}

export interface ZipArchive {
  readonly entries: ZipEntry[];
  read(entry: ZipEntry): Buffer;
  readHead(entry: ZipEntry, maxBytes: number): Buffer;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, offset);
  if (read !== length) throw new RangeError("read past the end of the zip");
  return buffer;
}

/** Calls `fn` with every entry in the zip at `file` and full or prefix readers over one open descriptor. */
export function withZip<T>(file: string, fn: (archive: ZipArchive) => T): T {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const tailAt = Math.max(0, size - END_SEARCH);
    const tail = readAt(fd, tailAt, size - tailAt);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END_OF_DIRECTORY) {
        end = i;
        break;
      }
    }
    if (end === -1) throw new Error(`${file} is not a zip`);
    const count = tail.readUInt16LE(end + 10);
    const directory = readAt(fd, tail.readUInt32LE(end + 16), tail.readUInt32LE(end + 12));
    const entries: ZipEntry[] = [];
    for (let at = 0, i = 0; i < count; i++) {
      if (directory.readUInt32LE(at) !== DIRECTORY_ENTRY) {
        throw new Error(`${file}'s directory is corrupt`);
      }
      const madeBy = directory.readUInt16LE(at + 4) >>> 8;
      const nameLength = directory.readUInt16LE(at + 28);
      const extAttr = directory.readUInt32LE(at + 38);
      const entry: ZipEntry = {
        name: directory.toString("utf8", at + 46, at + 46 + nameLength),
        method: directory.readUInt16LE(at + 10),
        compressedSize: directory.readUInt32LE(at + 20),
        uncompressedSize: directory.readUInt32LE(at + 24),
        headerAt: directory.readUInt32LE(at + 42),
        symlink: madeBy === 3 && ((extAttr >>> 16) & 0o170000) === 0o120000,
      };
      if (
        entry.compressedSize === 0xffffffff ||
        entry.uncompressedSize === 0xffffffff ||
        entry.headerAt === 0xffffffff
      ) {
        throw new Error(`${file} needs ZIP64, which this reader doesn't handle`);
      }
      entries.push(entry);
      at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    }
    return fn({
      entries,
      read: (entry) => readEntry(fd, file, entry),
      readHead: (entry, maxBytes) => readEntry(fd, file, entry, maxBytes),
    });
  } finally {
    closeSync(fd);
  }
}

function readEntry(fd: number, file: string, entry: ZipEntry, maxBytes?: number): Buffer {
  if (maxBytes !== undefined && (maxBytes <= 0 || entry.uncompressedSize === 0)) {
    return Buffer.alloc(0);
  }
  const header = readAt(fd, entry.headerAt, 30);
  if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new Error(`${file}: no ${entry.name}`);
  const dataAt = entry.headerAt + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (entry.method === 0) {
    const length =
      maxBytes === undefined ? entry.compressedSize : Math.min(entry.compressedSize, maxBytes);
    return readAt(fd, dataAt, length);
  }
  if (entry.method === 8) {
    if (maxBytes === undefined) {
      return inflateRawSync(readAt(fd, dataAt, entry.compressedSize));
    }
    const chunkLen = Math.min(entry.compressedSize, Math.max(4096, maxBytes * 4));
    const head = inflateRawSync(readAt(fd, dataAt, chunkLen), {
      finishFlush: constants.Z_SYNC_FLUSH,
    });
    if (
      head.length >= Math.min(entry.uncompressedSize, maxBytes) ||
      chunkLen === entry.compressedSize
    ) {
      return head.subarray(0, maxBytes);
    }
    return inflateRawSync(readAt(fd, dataAt, entry.compressedSize)).subarray(0, maxBytes);
  }
  throw new Error(`${file}: ${entry.name} is compressed with method ${entry.method}`);
}
