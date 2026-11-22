// What staging needs from a Windows PE file, read from its headers on any OS: whether it carries an
// Authenticode signature and whose, the DLLs it imports, its linker version and its file version.
// https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const DIRECTORY_IMPORT = 1;
const DIRECTORY_RESOURCE = 2;
const DIRECTORY_SECURITY = 4;
const DIRECTORY_DELAY_IMPORT = 13;
const RT_VERSION = 16;
const FIXED_FILE_INFO = 0xfeef04bd;
const WIN_CERT_TYPE_PKCS_SIGNED_DATA = 2;
/** The DER of the common name's object identifier, 2.5.4.3. */
const COMMON_NAME = Buffer.of(0x06, 0x03, 0x55, 0x04, 0x03);

export interface Pe {
  /** `<major>.<minor>`, the toolset that linked it, as `14.44`. */
  readonly linker: string;
  /** Whether its certificate table holds anything: an unsigned file's is empty. */
  readonly signed: boolean;
  /**
   * The common name on its signer's certificate, as `Microsoft Corporation`: null when it is
   * unsigned, or its signature can't be read. Only read, never verified.
   */
  readonly signer: string | null;
  readonly imports: readonly string[];
  readonly delayImports: readonly string[];
  /** VS_FIXEDFILEINFO's file version, as `14.52.37029.0`; null without a version resource. */
  readonly fileVersion: string | null;
}

/** Positioned reads: LanceDB's addon is about 350 MB. */
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

/**
 * The PE facts of `file`, a path or the file's bytes; null when it isn't a PE image. A header or
 * table that runs past its end throws a RangeError, so a broken DLL fails staging rather than being
 * skipped; a certificate table that does gives no signer.
 */
export function readPe(file: string | Buffer): Pe | null {
  if (Buffer.isBuffer(file)) return parse(bufferSource(file));
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    return parse({
      size,
      read(offset, length) {
        if (offset < 0 || offset + length > size) {
          throw new RangeError(`read past the end of ${file}`);
        }
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, offset);
        return buffer;
      },
    });
  } finally {
    closeSync(fd);
  }
}

function parse(source: Source): Pe | null {
  const { read, size } = source;
  if (size < 64 || read(0, 2).toString("latin1") !== "MZ") return null;
  const peAt = read(0x3c, 4).readUInt32LE(0);
  if (peAt + 24 > size || read(peAt, 4).toString("latin1") !== "PE\0\0") return null;
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
  const directory = (index: number) =>
    index < directoryCount
      ? {
          address: optional.readUInt32LE(directoriesAt + index * 8),
          size: optional.readUInt32LE(directoriesAt + index * 8 + 4),
        }
      : { address: 0, size: 0 };

  const sections: { virtualAddress: number; span: number; rawAt: number }[] = [];
  const sectionsAt = optionalAt + optionalSize;
  for (let i = 0; i < sectionCount; i++) {
    const header = read(sectionsAt + i * 40, 40);
    sections.push({
      virtualAddress: header.readUInt32LE(12),
      span: Math.max(header.readUInt32LE(8), header.readUInt32LE(16)),
      rawAt: header.readUInt32LE(20),
    });
  }
  const offsetOf = (rva: number): number | null => {
    const section = sections.find(
      (s) => rva >= s.virtualAddress && rva < s.virtualAddress + s.span,
    );
    return section === undefined ? null : rva - section.virtualAddress + section.rawAt;
  };
  const stringAt = (rva: number): string | null => {
    const at = offsetOf(rva);
    if (at === null) return null;
    const bytes = read(at, Math.min(260, size - at));
    const end = bytes.indexOf(0);
    return bytes.subarray(0, end === -1 ? bytes.length : end).toString("latin1");
  };

  const imports: string[] = [];
  const importTable = directory(DIRECTORY_IMPORT);
  const importsAt = importTable.address === 0 ? null : offsetOf(importTable.address);
  if (importsAt !== null) {
    for (let i = 0; ; i++) {
      const entry = read(importsAt + i * 20, 20);
      const name = entry.readUInt32LE(12);
      if (name === 0) break;
      const dll = stringAt(name);
      if (dll) imports.push(dll);
    }
  }
  const delayImports: string[] = [];
  const delayTable = directory(DIRECTORY_DELAY_IMPORT);
  const delayAt = delayTable.address === 0 ? null : offsetOf(delayTable.address);
  if (delayAt !== null) {
    for (let i = 0; ; i++) {
      const entry = read(delayAt + i * 32, 32);
      const name = entry.readUInt32LE(4);
      if (name === 0) break;
      // Attribute bit 0 marks RVAs; the old layout's VAs never appear in these files.
      const dll = entry.readUInt32LE(0) & 1 ? stringAt(name) : null;
      if (dll) delayImports.push(dll);
    }
  }
  // The certificate table's address is a file offset, not an RVA.
  const certificates = directory(DIRECTORY_SECURITY);
  const signed = certificates.address !== 0 && certificates.size > 0;
  return {
    linker: `${optional.readUInt8(2)}.${String(optional.readUInt8(3)).padStart(2, "0")}`,
    signed,
    signer: signed ? signerName(source, certificates.address, certificates.size) : null,
    imports,
    delayImports,
    fileVersion: fileVersion(source, directory(DIRECTORY_RESOURCE).address, offsetOf),
  };
}

/** A DER element: its tag, where it starts, and where its contents start and end. */
interface Der {
  readonly tag: number;
  readonly at: number;
  readonly start: number;
  readonly end: number;
}

function element(der: Buffer, at: number, limit = der.length): Der {
  const tag = der.readUInt8(at);
  let length = der.readUInt8(at + 1);
  let start = at + 2;
  if (length & 0x80) {
    // BER's indefinite length, 0x80, isn't DER.
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new RangeError("not DER");
    length = der.readUIntBE(start, count);
    start += count;
  }
  if (start + length > limit) throw new RangeError("a DER element runs past its parent");
  return { tag, at, start, end: start + length };
}

function children(der: Buffer, parent: Der | undefined): Der[] {
  if (parent === undefined) throw new RangeError("a DER element is missing");
  const found: Der[] = [];
  for (let at = parent.start; at < parent.end; ) {
    const child = element(der, at, parent.end);
    found.push(child);
    at = child.end;
  }
  return found;
}

function encoded(der: Buffer, item: Der | undefined): Buffer {
  if (item === undefined) throw new RangeError("a DER element is missing");
  return der.subarray(item.at, item.end);
}

/**
 * The common name on the certificate of a WIN_CERTIFICATE's signer: in its PKCS#7 SignedData, the
 * certificate whose issuer and serial number the first SignerInfo names (RFC 2315). Authenticode's
 * certificates come in no set order: Electron's d3dcompiler_47.dll lists its signer's second.
 */
function signerName(source: Source, at: number, size: number): string | null {
  if (size < 8 || at + size > source.size) return null;
  const header = source.read(at, 8);
  const length = header.readUInt32LE(0);
  if (header.readUInt16LE(6) !== WIN_CERT_TYPE_PKCS_SIGNED_DATA || length <= 8 || length > size) {
    return null;
  }
  const der = source.read(at + 8, length - 8);
  try {
    const [, content] = children(der, element(der, 0));
    const fields = children(der, children(der, content)[0]);
    const certificates = fields.find((field) => field.tag === 0xa0);
    const [, named] = children(der, children(der, fields.at(-1))[0]);
    // A SignerInfo that names its certificate by key identifier, [0], has no issuer to match.
    if (named?.tag !== 0x30) return null;
    const [issuer, serial] = children(der, named);
    for (const certificate of children(der, certificates)) {
      const tbs = children(der, children(der, certificate)[0]);
      // The version, [0], is optional.
      const [number, , by, , subject] = tbs[0]?.tag === 0xa0 ? tbs.slice(1) : tbs;
      if (
        encoded(der, number).equals(encoded(der, serial)) &&
        encoded(der, by).equals(encoded(der, issuer))
      ) {
        return commonName(der, subject);
      }
    }
    return null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** The common name in an X.501 Name, decoded by its string type. */
function commonName(der: Buffer, name: Der | undefined): string | null {
  for (const set of children(der, name)) {
    for (const attribute of children(der, set)) {
      const [type, value] = children(der, attribute);
      if (value === undefined || !encoded(der, type).equals(COMMON_NAME)) continue;
      const text = der.subarray(value.start, value.end);
      // BMPString is UTF-16 big-endian, UTF8String UTF-8, and the rest ASCII.
      if (value.tag === 0x1e) return Buffer.from(text).swap16().toString("utf16le");
      return text.toString(value.tag === 0x0c ? "utf8" : "latin1");
    }
  }
  return null;
}

/** The first entry of the resource directory at `at`, or the one with `id`. */
function resourceEntry(source: Source, at: number, id?: number): number | null {
  const header = source.read(at, 16);
  const count = header.readUInt16LE(12) + header.readUInt16LE(14);
  for (let i = 0; i < count; i++) {
    const entry = source.read(at + 16 + i * 8, 8);
    const name = entry.readUInt32LE(0);
    if (id === undefined || (!(name & 0x80000000) && name === id)) return entry.readUInt32LE(4);
  }
  return null;
}

/** RT_VERSION's VS_FIXEDFILEINFO: type, then name, then language, each the first one found. */
function fileVersion(
  source: Source,
  rva: number,
  offsetOf: (rva: number) => number | null,
): string | null {
  const root = rva === 0 ? null : offsetOf(rva);
  if (root === null) return null;
  let entry = resourceEntry(source, root, RT_VERSION);
  for (let level = 0; level < 2 && entry !== null; level++) {
    if (!(entry & 0x80000000)) return null;
    entry = resourceEntry(source, root + (entry & 0x7fffffff));
  }
  if (entry === null || entry & 0x80000000) return null;
  const data = source.read(root + entry, 8);
  const at = offsetOf(data.readUInt32LE(0));
  if (at === null) return null;
  const info = source.read(at, Math.min(data.readUInt32LE(4), source.size - at));
  for (let i = 0; i + 16 <= info.length; i += 4) {
    if (info.readUInt32LE(i) !== FIXED_FILE_INFO) continue;
    const high = info.readUInt32LE(i + 8);
    const low = info.readUInt32LE(i + 12);
    return [high >>> 16, high & 0xffff, low >>> 16, low & 0xffff].join(".");
  }
  return null;
}

/** Compares dotted versions numerically, a missing part counting as 0. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
