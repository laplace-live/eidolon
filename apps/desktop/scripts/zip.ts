// Reads the files of a zip, as the unsigned-PE list needs Electron's own zip, the one electron-builder
// packs: stored and deflated entries, no ZIP64. https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
/** The end record's size plus the longest comment it may carry. */
const END_SEARCH = 22 + 0xffff;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly headerAt: number;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, offset);
  if (read !== length) throw new RangeError("read past the end of the zip");
  return buffer;
}

/** Every file in the zip at `file`, by its name there, with what `read` returns for it. */
export function readZip(file: string): { entries: ZipEntry[]; read(entry: ZipEntry): Buffer } {
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
      const nameLength = directory.readUInt16LE(at + 28);
      const entry = {
        name: directory.toString("utf8", at + 46, at + 46 + nameLength),
        method: directory.readUInt16LE(at + 10),
        compressedSize: directory.readUInt32LE(at + 20),
        headerAt: directory.readUInt32LE(at + 42),
      };
      if (entry.compressedSize === 0xffffffff || entry.headerAt === 0xffffffff) {
        throw new Error(`${file} needs ZIP64, which this reader doesn't handle`);
      }
      entries.push(entry);
      at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    }
    return { entries, read: (entry) => readEntry(file, entry) };
  } finally {
    closeSync(fd);
  }
}

function readEntry(file: string, entry: ZipEntry): Buffer {
  const fd = openSync(file, "r");
  try {
    const header = readAt(fd, entry.headerAt, 30);
    if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new Error(`${file}: no ${entry.name}`);
    const dataAt = entry.headerAt + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = readAt(fd, dataAt, entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data);
    throw new Error(`${file}: ${entry.name} is compressed with method ${entry.method}`);
  } finally {
    closeSync(fd);
  }
}
