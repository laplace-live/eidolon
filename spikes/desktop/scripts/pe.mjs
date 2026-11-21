// What the stage needs from a Windows PE file, read from its headers: the Authenticode certificate
// table (empty means unsigned), the DLLs it imports and delay-loads, its linker version and its
// subsystem. Positioned reads only: LanceDB's addon is about 350 MB.
// https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const DIRECTORY_IMPORT = 1;
const DIRECTORY_SECURITY = 4;
const DIRECTORY_DELAY_IMPORT = 13;
export const SUBSYSTEMS = { 2: "windows-gui", 3: "windows-console" };

/** The PE facts of `file`, or null when it is not a PE image. */
export function readPe(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (offset, length) => {
      if (offset < 0 || offset + length > size) throw new RangeError(`read past the end of ${file}`);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, offset);
      return buffer;
    };
    if (size < 64 || read(0, 2).toString("latin1") !== "MZ") return null;
    const peAt = read(0x3c, 4).readUInt32LE(0);
    if (read(peAt, 4).toString("latin1") !== "PE\0\0") return null;
    const coff = read(peAt + 4, 20);
    const sectionCount = coff.readUInt16LE(2);
    const optionalSize = coff.readUInt16LE(16);
    const optionalAt = peAt + 24;
    const optional = read(optionalAt, optionalSize);
    const magic = optional.readUInt16LE(0);
    const plus = magic === 0x20b;
    if (!plus && magic !== 0x10b) return null;
    const directoryCount = optional.readUInt32LE(plus ? 108 : 92);
    const directoriesAt = plus ? 112 : 96;
    const directory = (index) =>
      index < directoryCount
        ? {
            address: optional.readUInt32LE(directoriesAt + index * 8),
            size: optional.readUInt32LE(directoriesAt + index * 8 + 4),
          }
        : { address: 0, size: 0 };

    const sections = [];
    const sectionsAt = optionalAt + optionalSize;
    for (let i = 0; i < sectionCount; i++) {
      const header = read(sectionsAt + i * 40, 40);
      sections.push({
        virtualSize: header.readUInt32LE(8),
        virtualAddress: header.readUInt32LE(12),
        rawSize: header.readUInt32LE(16),
        rawAt: header.readUInt32LE(20),
      });
    }
    const offsetOf = (rva) => {
      for (const s of sections) {
        if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
          return rva - s.virtualAddress + s.rawAt;
        }
      }
      return null;
    };
    const stringAt = (rva) => {
      const at = offsetOf(rva);
      if (at === null) return null;
      const bytes = read(at, Math.min(260, size - at));
      const end = bytes.indexOf(0);
      return bytes.subarray(0, end === -1 ? bytes.length : end).toString("latin1");
    };

    const imports = [];
    const importTable = directory(DIRECTORY_IMPORT);
    if (importTable.address !== 0) {
      const at = offsetOf(importTable.address);
      for (let i = 0; at !== null; i++) {
        const entry = read(at + i * 20, 20);
        const name = entry.readUInt32LE(12);
        if (name === 0 && entry.readUInt32LE(16) === 0) break;
        const dll = stringAt(name);
        if (dll) imports.push(dll);
      }
    }
    const delayImports = [];
    const delayTable = directory(DIRECTORY_DELAY_IMPORT);
    if (delayTable.address !== 0) {
      const at = offsetOf(delayTable.address);
      for (let i = 0; at !== null; i++) {
        const entry = read(at + i * 32, 32);
        const name = entry.readUInt32LE(4);
        if (name === 0) break;
        // Attributes bit 0 clear: the old layout, whose fields are VAs, never seen in these files.
        const dll = entry.readUInt32LE(0) & 1 ? stringAt(name) : null;
        if (dll) delayImports.push(dll);
      }
    }
    const certificates = directory(DIRECTORY_SECURITY);
    return {
      machine: coff.readUInt16LE(0) === 0x8664 ? "x64" : `0x${coff.readUInt16LE(0).toString(16)}`,
      linker: `${optional.readUInt8(2)}.${String(optional.readUInt8(3)).padStart(2, "0")}`,
      subsystem: SUBSYSTEMS[optional.readUInt16LE(68)] ?? String(optional.readUInt16LE(68)),
      // The certificate table's address is a file offset, not an RVA.
      signed: certificates.address !== 0 && certificates.size > 0,
      certificateBytes: certificates.size,
      imports,
      delayImports,
    };
  } finally {
    closeSync(fd);
  }
}

// usage: node scripts/pe.mjs <file>...
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("pe.mjs")) {
  for (const file of process.argv.slice(2)) console.log(file, JSON.stringify(readPe(file)));
}
