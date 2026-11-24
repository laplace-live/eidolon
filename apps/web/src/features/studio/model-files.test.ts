import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  isP2lrtHeader,
  MAX_MODEL_BYTES,
  MODEL_ACCEPT,
  modelFileFrom,
  modelFileFromDrop,
  modelFileProblem,
  p2lrtFromZip,
  pickFromFolder,
} from "./model-files";

const HEADER = [0x50, 0x32, 0x4c, 0x52, 0x54, 0, 0, 0];
/** A stand-in for a .p2lrt: its header, then a body that deflates well. */
const RIG = Uint8Array.from([...HEADER, ...new TextEncoder().encode("rig ".repeat(500))]);

interface Entry {
  readonly path: string;
  readonly data: Uint8Array<ArrayBuffer>;
  readonly method?: 0 | 8;
  /** What the zip claims the entry unpacks to, when it lies. */
  readonly size?: number;
  readonly flags?: number;
}

/** A zip as an archiver writes one, without CRCs, which the reader doesn't check. */
function zip(entries: readonly Entry[], comment = ""): Blob {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const directory: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const method = entry.method ?? 0;
    const packed = method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const size = entry.size ?? entry.data.byteLength;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, entry.flags ?? 0, true);
    local.setUint16(8, method, true);
    local.setUint32(18, packed.byteLength, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.byteLength, true);
    parts.push(new Uint8Array(local.buffer), name, packed);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, entry.flags ?? 0, true);
    central.setUint16(10, method, true);
    central.setUint32(20, packed.byteLength, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.byteLength, true);
    central.setUint32(42, offset, true);
    directory.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.byteLength + packed.byteLength;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.byteLength, 0);
  const note = new TextEncoder().encode(comment);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, note.byteLength, true);
  return new Blob([...parts, ...directory, new Uint8Array(end.buffer), note]);
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

const file = (data: Uint8Array<ArrayBuffer> | string, name: string) => new File([data], name);

test("a picker takes a .p2lrt or a zip, as large as the server takes", () => {
  expect(MODEL_ACCEPT.split(",")).toEqual([".p2lrt", ".zip", "application/zip"]);
  expect(MAX_MODEL_BYTES).toBe(200 * 1024 * 1024);
});

describe("modelFileProblem", () => {
  test("a .p2lrt in any case is a model, up to the server's limit", () => {
    expect(modelFileProblem({ name: "tml.p2lrt", size: 3_471_396 })).toBeNull();
    expect(modelFileProblem({ name: "TML.P2LRT", size: MAX_MODEL_BYTES })).toBeNull();
    expect(modelFileProblem({ name: "tml.p2lrt", size: MAX_MODEL_BYTES + 1 })).toBe("size");
  });

  test("anything else is the wrong type", () => {
    expect(modelFileProblem({ name: "tml.png", size: 10 })).toBe("type");
    expect(modelFileProblem({ name: "p2lrt", size: 10 })).toBe("type");
    expect(modelFileProblem({ name: ".p2lrt", size: 10 })).toBe("type");
  });
});

test("the header is the server's: P2LRT and three NULs", () => {
  expect(isP2lrtHeader(Uint8Array.from(HEADER))).toBe(true);
  expect(isP2lrtHeader(RIG)).toBe(true);
  expect(isP2lrtHeader(Uint8Array.from(HEADER.slice(0, 4)))).toBe(false);
  expect(isP2lrtHeader(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(false);
  expect(isP2lrtHeader(new Uint8Array())).toBe(false);
});

describe("pickFromFolder", () => {
  const picked = (...paths: string[]) =>
    paths.map((path) => ({ name: path, webkitRelativePath: path }));

  test("finds the one .p2lrt in a web export, at any depth", () => {
    const files = picked("web/index.html", "web/p2l.js", "web/assets/tml.p2lrt");
    expect(pickFromFolder(files)).toBe(files[2]);
  });

  test("skips what macOS adds beside a file", () => {
    const files = picked("web/._tml.p2lrt", "web/__MACOSX/web/tml.p2lrt", "web/tml.p2lrt");
    expect(pickFromFolder(files)).toBe(files[2]);
  });

  test("says when there is none, or more than one", () => {
    expect(pickFromFolder(picked("web/index.html", "web/p2l_runtime.wasm"))).toBe("none");
    expect(pickFromFolder(picked("web/a.p2lrt", "web/b.p2lrt"))).toBe("several");
    expect(pickFromFolder([])).toBe("none");
  });
});

describe("p2lrtFromZip", () => {
  test("reads a stored entry, named as it was", async () => {
    const found = await p2lrtFromZip(
      zip([
        { path: "web/index.html", data: new TextEncoder().encode("<html>") },
        { path: "web/tml.p2lrt", data: RIG },
      ]),
    );
    expect(found).toBeInstanceOf(File);
    expect((found as File).name).toBe("tml.p2lrt");
    expect(await bytesOf(found as File)).toEqual([...RIG]);
  });

  test("inflates a deflated entry", async () => {
    const found = await p2lrtFromZip(zip([{ path: "tml.p2lrt", data: RIG, method: 8 }]));
    expect(await bytesOf(found as File)).toEqual([...RIG]);
  });

  test("ignores what macOS adds, and a comment that holds the end record's signature", async () => {
    const found = await p2lrtFromZip(
      zip(
        [
          { path: "__MACOSX/web/._tml.p2lrt", data: Uint8Array.of(0, 5, 22, 7) },
          { path: "web/tml.p2lrt", data: RIG, method: 8 },
        ],
        "PK\u0005\u0006 is where a zip's end record starts, as this comment says",
      ),
    );
    expect(await bytesOf(found as File)).toEqual([...RIG]);
  });

  test("says when it holds no .p2lrt, or two", async () => {
    const page = { path: "web/index.html", data: new TextEncoder().encode("<html>") };
    expect(await p2lrtFromZip(zip([page]))).toBe("none");
    expect(await p2lrtFromZip(zip([]))).toBe("none");
    expect(
      await p2lrtFromZip(
        zip([
          { path: "a.p2lrt", data: RIG },
          { path: "b/b.p2lrt", data: RIG, method: 8 },
        ]),
      ),
    ).toBe("several");
  });

  test("an entry past the limit is never unpacked", async () => {
    const big = zip([{ path: "tml.p2lrt", data: RIG, method: 8 }]);
    expect(await p2lrtFromZip(big, RIG.byteLength - 1)).toBe("size");
    expect(await p2lrtFromZip(big, RIG.byteLength)).toBeInstanceOf(File);
  });

  test("an entry that unpacks to more than it claims stops short", async () => {
    const bomb = new Uint8Array(4 * 1024 * 1024);
    bomb.set(HEADER);
    expect(await p2lrtFromZip(zip([{ path: "tml.p2lrt", data: bomb, method: 8, size: 64 }]))).toBe(
      "zip",
    );
    expect(await p2lrtFromZip(zip([{ path: "tml.p2lrt", data: RIG, size: 10 }]))).toBe("zip");
  });

  test("what isn't a zip it reads is refused", async () => {
    expect(await p2lrtFromZip(new Blob([RIG]))).toBe("zip");
    expect(await p2lrtFromZip(new Blob())).toBe("zip");
    const encrypted = zip([{ path: "tml.p2lrt", data: RIG, flags: 1 }]);
    expect(await p2lrtFromZip(encrypted)).toBe("zip");
    const shortened = zip([{ path: "tml.p2lrt", data: RIG, method: 8 }]);
    const broken = new Blob([new Uint8Array((await shortened.arrayBuffer()).slice(0, 60))]);
    expect(await p2lrtFromZip(broken)).toBe("zip");
  });
});

describe("modelFileFrom", () => {
  test("a .p2lrt goes as it is, once its header is a model's", async () => {
    const rig = file(RIG, "tml.p2lrt");
    expect(await modelFileFrom([rig])).toBe(rig);
    expect(await modelFileFrom([file("PNG?", "fake.p2lrt")])).toBe("header");
    expect(await modelFileFrom([file(RIG, "tml.png")])).toBe("type");
    expect(await modelFileFrom([])).toBe("none");
  });

  test("a zip gives the model inside it, checked the same way", async () => {
    const inside = await modelFileFrom([
      new File([zip([{ path: "web/tml.p2lrt", data: RIG, method: 8 }])], "web.zip"),
    ]);
    expect((inside as File).name).toBe("tml.p2lrt");
    expect(
      await modelFileFrom([
        new File([zip([{ path: "tml.p2lrt", data: new TextEncoder().encode("nope") }])], "x.zip"),
      ]),
    ).toBe("header");
    expect(await modelFileFrom([new File([RIG], "web.ZIP")])).toBe("zip");
  });

  test("several files are a folder's, of which one is the model", async () => {
    const rig = file(RIG, "tml.p2lrt");
    expect(await modelFileFrom([file("<html>", "index.html"), rig])).toBe(rig);
    expect(await modelFileFrom([rig, file(RIG, "two.p2lrt")])).toBe("several");
    expect(await modelFileFrom([file("<html>", "index.html"), file("x", "p2l.js")])).toBe("none");
  });

  test("a file the browser can't read, as one changed since it was picked, says so", async () => {
    class Unreadable extends File {
      override slice(): Blob {
        const blob = new Blob();
        blob.arrayBuffer = () => Promise.reject(new DOMException("changed", "NotReadableError"));
        return blob;
      }
    }
    expect(await modelFileFrom([new Unreadable([RIG], "tml.p2lrt")])).toBe("read");
    expect(await modelFileFrom([new Unreadable([RIG], "web.zip")])).toBe("read");
  });
});

describe("modelFileFromDrop", () => {
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

  /** A file as a drop's webkitGetAsEntry gives it. */
  function fileEntry(path: string, data: Uint8Array<ArrayBuffer> | string = RIG): FileSystemEntry {
    const entry = {
      isFile: true,
      isDirectory: false,
      name: nameOf(path),
      fullPath: `/${path}`,
      file: (done: (file: File) => void) => done(new File([data], nameOf(path))),
    };
    return entry as unknown as FileSystemEntry;
  }

  /** A folder as a drop gives it, whose reader hands out `batch` entries a call, as browsers do. */
  function folderEntry(
    path: string,
    children: readonly FileSystemEntry[],
    { batch = 2, broken = false } = {},
  ): FileSystemEntry {
    const entry = {
      isFile: false,
      isDirectory: true,
      name: nameOf(path),
      fullPath: `/${path}`,
      createReader: () => {
        let at = 0;
        return {
          readEntries: (
            done: (entries: FileSystemEntry[]) => void,
            failed: (error: DOMException) => void,
          ) => {
            if (broken) {
              failed(new DOMException("gone", "NotFoundError"));
              return;
            }
            done(children.slice(at, at + batch));
            at += batch;
          },
        };
      },
    };
    return entry as unknown as FileSystemEntry;
  }

  /** A drop of `entries`, whose files list a folder as one empty file of its name. */
  const drop = (...entries: FileSystemEntry[]) => ({
    entries,
    files: entries.map((entry) => new File([], entry.name)),
  });

  test("a folder gives the one .p2lrt under it, at any depth and after every batch", async () => {
    const web = folderEntry("web", [
      fileEntry("web/index.html", "<html>"),
      fileEntry("web/p2l.js", "x"),
      fileEntry("web/p2l_runtime.wasm", "x"),
      folderEntry("web/assets", [fileEntry("web/assets/tml.p2lrt")]),
    ]);
    const picked = await modelFileFromDrop(drop(web));
    expect(picked).toBeInstanceOf(File);
    expect(await bytesOf(picked as File)).toEqual([...RIG]);
    expect((picked as File).name).toBe("tml.p2lrt");
  });

  test("a folder with none, or more than one, says so, leaving out what macOS adds", async () => {
    const mac = folderEntry("web/__MACOSX", [fileEntry("web/__MACOSX/tml.p2lrt")]);
    expect(
      await modelFileFromDrop(drop(folderEntry("web", [fileEntry("web/index.html", "x"), mac]))),
    ).toBe("none");
    expect(
      await modelFileFromDrop(
        drop(folderEntry("web", [fileEntry("web/a.p2lrt"), fileEntry("web/._a.p2lrt", "x")])),
      ),
    ).toBeInstanceOf(File);
    expect(
      await modelFileFromDrop(
        drop(folderEntry("web", [fileEntry("web/a.p2lrt"), fileEntry("web/b.p2lrt")])),
      ),
    ).toBe("several");
    expect(
      await modelFileFromDrop(
        drop(folderEntry("a", [fileEntry("a/x.p2lrt")]), fileEntry("y.p2lrt")),
      ),
    ).toBe("several");
  });

  test("the model in a folder is checked as a picked one is", async () => {
    const fake = folderEntry("web", [fileEntry("web/tml.p2lrt", "PNG?")]);
    expect(await modelFileFromDrop(drop(fake))).toBe("header");
  });

  test("a folder the browser can't read says so", async () => {
    expect(await modelFileFromDrop(drop(folderEntry("web", [], { broken: true })))).toBe("read");
  });

  test("files with no folder among them go as picked ones do", async () => {
    const rig = file(RIG, "tml.p2lrt");
    expect(await modelFileFromDrop({ entries: [fileEntry("tml.p2lrt")], files: [rig] })).toBe(rig);
    expect(await modelFileFromDrop({ entries: [null], files: [file("x", "her.png")] })).toBe(
      "type",
    );
  });
});
