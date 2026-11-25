// A model picked or dropped for import: a .p2lrt as PSD2Live exports it, the folder of its web
// export, or that folder zipped. The page checks what it can before the upload, and the server
// loads the model again before it keeps it.
import type { MAX_MODEL_BYTES as LIMIT } from "@/lib/api";

/** The server refuses larger models. */
export const MAX_MODEL_BYTES: typeof LIMIT = 209_715_200;

/** A file input's `accept`: a .p2lrt, or a web export zipped. */
export const MODEL_ACCEPT = ".p2lrt,.zip,application/zip";

/**
 * Why nothing can be imported from what was picked: not a model or a zip (`type`), too large
 * (`size`), a .p2lrt by name but not by its bytes (`header`), no .p2lrt in a folder or zip
 * (`none`), more than one (`several`), a zip this page can't read (`zip`), or a file the browser
 * couldn't read, such as one changed since it was picked (`read`).
 */
export type ModelFileProblem = "type" | "size" | "header" | "none" | "several" | "zip" | "read";

/** What every .p2lrt starts with: "P2LRT" and three NULs, as the server checks it. */
const MAGIC = [0x50, 0x32, 0x4c, 0x52, 0x54, 0, 0, 0] as const;

export function isP2lrtHeader(head: Uint8Array): boolean {
  return MAGIC.every((byte, index) => head[index] === byte);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** What macOS adds to what it zips or copies: `__MACOSX/` and `._` files, which hold no model. */
function isMacExtra(path: string): boolean {
  return path.split("/").some((part) => part === "__MACOSX" || part.startsWith("._"));
}

function isModelPath(path: string): boolean {
  return !path.endsWith("/") && extensionOf(path) === ".p2lrt" && !isMacExtra(path);
}

/** Why a file can't go up as a model by its name and size; null when it can. */
export function modelFileProblem(file: Pick<File, "name" | "size">): "type" | "size" | null {
  if (extensionOf(file.name) !== ".p2lrt") return "type";
  return file.size > MAX_MODEL_BYTES ? "size" : null;
}

/** The one .p2lrt among a folder's files, by the paths the folder picker gives them. */
export function pickFromFolder<F extends Pick<File, "name" | "webkitRelativePath">>(
  files: readonly F[],
): F | "none" | "several" {
  const models = files.filter((file) => isModelPath(file.webkitRelativePath || file.name));
  if (models.length > 1) return "several";
  return models[0] ?? "none";
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const END_SIZE = 22;
const ENTRY_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
/** A field at its largest stands for a ZIP64 value, which an export's few files never need. */
const ZIP64_16 = 0xffff;
const ZIP64_32 = 0xffffffff;
/** The most of a zip's file list read: a web export lists a handful of files. */
const MAX_DIRECTORY = 1 << 20;

interface ZipEntry {
  readonly path: string;
  readonly flags: number;
  readonly method: number;
  readonly packed: number;
  readonly size: number;
  readonly offset: number;
}

async function view(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/** Where the zip's file list is, from its end record; null when it has none this page reads. */
async function directoryOf(
  zip: Blob,
): Promise<{ readonly start: number; readonly size: number; readonly count: number } | null> {
  if (zip.size < END_SIZE) return null;
  const tailStart = Math.max(0, zip.size - END_SIZE - MAX_COMMENT);
  const tail = await view(zip, tailStart, zip.size);
  for (let at = tail.byteLength - END_SIZE; at >= 0; at--) {
    if (tail.getUint32(at, true) !== END_OF_DIRECTORY) continue;
    // The end record's comment runs to the end of the file; a signature inside a comment doesn't.
    if (at + END_SIZE + tail.getUint16(at + 20, true) !== tail.byteLength) continue;
    const count = tail.getUint16(at + 10, true);
    const size = tail.getUint32(at + 12, true);
    const start = tail.getUint32(at + 16, true);
    if (count === ZIP64_16 || size === ZIP64_32 || start === ZIP64_32) return null;
    if (size > MAX_DIRECTORY || start + size > tailStart + at) return null;
    return { start, size, count };
  }
  return null;
}

function entriesOf(directory: DataView, count: number): ZipEntry[] | null {
  const names = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + ENTRY_SIZE > directory.byteLength) return null;
    if (directory.getUint32(at, true) !== DIRECTORY_ENTRY) return null;
    const nameLength = directory.getUint16(at + 28, true);
    const next =
      at +
      ENTRY_SIZE +
      nameLength +
      directory.getUint16(at + 30, true) +
      directory.getUint16(at + 32, true);
    if (next > directory.byteLength) return null;
    const name = new Uint8Array(directory.buffer, at + ENTRY_SIZE, nameLength);
    entries.push({
      path: names.decode(name),
      flags: directory.getUint16(at + 8, true),
      method: directory.getUint16(at + 10, true),
      packed: directory.getUint32(at + 20, true),
      size: directory.getUint32(at + 24, true),
      offset: directory.getUint32(at + 42, true),
    });
    at = next;
  }
  return entries;
}

/** An entry's bytes inflated, stopping as soon as they pass what it says it holds. */
async function inflated(data: Blob, size: number): Promise<Uint8Array<ArrayBuffer>[] | null> {
  const reader = data.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > size) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return total === size ? chunks : null;
}

/**
 * The one .p2lrt in a zip, such as PSD2Live's web export zipped, read from the zip's own file list
 * without unpacking anything else. An entry is never inflated past `limit`, nor past the size its
 * zip claims for it, so a zip built to unpack huge stops at once.
 */
export async function p2lrtFromZip(
  zip: Blob,
  limit: number = MAX_MODEL_BYTES,
): Promise<File | "none" | "several" | "size" | "zip"> {
  const directory = await directoryOf(zip);
  if (directory === null) return "zip";
  const entries = entriesOf(
    await view(zip, directory.start, directory.start + directory.size),
    directory.count,
  );
  if (entries === null) return "zip";
  const models = entries.filter((entry) => isModelPath(entry.path));
  if (models.length > 1) return "several";
  const [entry] = models;
  if (entry === undefined) return "none";
  // Bit 0: encrypted.
  if ((entry.flags & 1) !== 0) return "zip";
  if (entry.size === ZIP64_32 || entry.packed === ZIP64_32 || entry.offset === ZIP64_32) {
    return "zip";
  }
  if (entry.size > limit) return "size";
  const local = await view(zip, entry.offset, entry.offset + LOCAL_SIZE);
  if (local.byteLength < LOCAL_SIZE || local.getUint32(0, true) !== LOCAL_HEADER) return "zip";
  const start = entry.offset + LOCAL_SIZE + local.getUint16(26, true) + local.getUint16(28, true);
  const end = start + entry.packed;
  if (end > zip.size) return "zip";
  const name = baseName(entry.path);
  const data = zip.slice(start, end);
  if (entry.method === 0) return entry.packed === entry.size ? new File([data], name) : "zip";
  if (entry.method !== 8) return "zip";
  const chunks = await inflated(data, entry.size);
  return chunks === null ? "zip" : new File(chunks, name);
}

/** `file` once its name, size and header say it's a model; else why not. */
async function checked(file: File): Promise<File | ModelFileProblem> {
  const problem = modelFileProblem(file);
  if (problem !== null) return problem;
  const head = new Uint8Array(await file.slice(0, MAGIC.length).arrayBuffer());
  return isP2lrtHeader(head) ? file : "header";
}

async function chosen(files: readonly File[]): Promise<File | ModelFileProblem> {
  let file: File;
  // A folder picked holds its files under its own name, even a folder of one.
  if (files.length > 1 || files.some((each) => Boolean(each.webkitRelativePath))) {
    const picked = pickFromFolder(files);
    if (typeof picked === "string") return picked;
    file = picked;
  } else {
    const [only] = files;
    if (only === undefined) return "none";
    if (extensionOf(only.name) === ".zip") {
      const extracted = await p2lrtFromZip(only);
      if (typeof extracted === "string") return extracted;
      file = extracted;
    } else {
      file = only;
    }
  }
  return checked(file);
}

/**
 * The .p2lrt to import from what was picked or dropped: one .p2lrt, one zip holding one, or the
 * files of a folder holding one; else why there is none.
 */
export async function modelFileFrom(files: readonly File[]): Promise<File | ModelFileProblem> {
  try {
    return await chosen(files);
  } catch {
    return "read";
  }
}

/**
 * A model's file for one upload, which takes it: an upload's variables outlive its answer, kept by
 * the mutation and by the render before the next, and a model taken from a zip is held in memory.
 */
export class ModelUpload {
  readonly filename: string;
  #file: Blob | null;

  constructor(file: File) {
    this.filename = file.name;
    this.#file = file;
  }

  /** The file to send, given once. */
  take(): Blob {
    const file = this.#file ?? new Blob();
    this.#file = null;
    return file;
  }
}

/** What a drop holds, taken in its event, after which its items are gone. */
export interface Dropped {
  /** Each item's `webkitGetAsEntry()`, which reaches into a folder. */
  readonly entries: readonly (FileSystemEntry | null)[];
  /** Its files, in which a folder is a file of its name, with nothing to read. */
  readonly files: readonly File[];
}

/** A folder's entries, which its reader gives a batch at a time until an empty one. */
async function entriesIn(folder: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = folder.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((done, failed) =>
      reader.readEntries(done, failed),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** The .p2lrt files under what was dropped, each folder read all the way down. */
async function modelEntries(dropped: readonly FileSystemEntry[]): Promise<FileSystemFileEntry[]> {
  const found: FileSystemFileEntry[] = [];
  const queue = [...dropped];
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    if (entry.isDirectory) {
      if (!isMacExtra(entry.fullPath)) {
        queue.push(...(await entriesIn(entry as FileSystemDirectoryEntry)));
      }
    } else if (entry.isFile && isModelPath(entry.fullPath)) {
      found.push(entry as FileSystemFileEntry);
    }
  }
  return found;
}

/**
 * The .p2lrt to import from a drop: as from a picker, unless a folder is among what was dropped,
 * which is read for the one model under it, as the folder picker finds it.
 */
export async function modelFileFromDrop(dropped: Dropped): Promise<File | ModelFileProblem> {
  const entries = dropped.entries.filter((entry) => entry !== null);
  if (!entries.some((entry) => entry.isDirectory)) return modelFileFrom(dropped.files);
  try {
    const models = await modelEntries(entries);
    if (models.length > 1) return "several";
    const [model] = models;
    if (model === undefined) return "none";
    return await checked(await new Promise<File>((done, failed) => model.file(done, failed)));
  } catch {
    return "read";
  }
}
