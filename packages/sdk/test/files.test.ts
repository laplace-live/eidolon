import { describe, expect, test } from "vitest";
import { chatFileKind, fittedSize, goesAsIs, isUtf8Text } from "../src/chat/files.ts";
import { MAX_IMAGE_BYTES } from "../src/index.ts";

describe("chatFileKind", () => {
  test("an image by its type, a text file by its type or else its name, and nothing else", () => {
    expect(chatFileKind({ type: "image/heic", name: "IMG_0001.HEIC" })).toBe("image");
    expect(chatFileKind({ type: "image/svg+xml", name: "logo.svg" })).toBeNull();
    expect(chatFileKind({ type: "text/markdown", name: "notes" })).toBe("file");
    expect(chatFileKind({ type: "application/json", name: "data.json" })).toBe("file");
    expect(chatFileKind({ type: "", name: "lyrics.LRC" })).toBe("file");
    expect(chatFileKind({ type: "", name: "photo.JPG" })).toBe("image");
    expect(chatFileKind({ type: "application/octet-stream", name: "photo.jpg" })).toBeNull();
    expect(chatFileKind({ type: "", name: ".md" })).toBeNull();
    expect(chatFileKind({ type: "application/pdf", name: "paper.pdf" })).toBeNull();
    expect(chatFileKind({ type: "", name: "README" })).toBeNull();
  });
});

describe("fittedSize", () => {
  test("keeps an image that fits, and scales one past 2048² pixels or a 2576 px edge", () => {
    expect(fittedSize(1170, 2532)).toEqual({ width: 1170, height: 2532 });
    expect(fittedSize(4032, 3024)).toEqual({ width: 2364, height: 1773 });
    expect(fittedSize(6000, 1000)).toEqual({ width: 2576, height: 429 });
    expect(fittedSize(10_000, 1)).toEqual({ width: 2576, height: 1 });
  });
});

describe("goesAsIs", () => {
  test("a PNG or WebP that fits goes as it is; a JPEG is always drawn again", () => {
    expect(goesAsIs("image/png", 1_000_000, 1920, 1080)).toBe(true);
    expect(goesAsIs("image/webp", MAX_IMAGE_BYTES, 1920, 1080)).toBe(true);
    expect(goesAsIs("image/png", MAX_IMAGE_BYTES + 1, 1920, 1080)).toBe(false);
    expect(goesAsIs("image/png", 1_000, 4032, 3024)).toBe(false);
    expect(goesAsIs("image/jpeg", 1_000, 640, 480)).toBe(false);
    expect(goesAsIs("image/gif", 1_000, 640, 480)).toBe(false);
  });
});

describe("isUtf8Text", () => {
  test("is UTF-8 with no NUL, as a text file the server keeps is", () => {
    expect(isUtf8Text(new TextEncoder().encode("第一章\n从前"))).toBe(true);
    expect(isUtf8Text(new Uint8Array([0xe7, 0xac]))).toBe(false);
    expect(isUtf8Text(new Uint8Array([0x61, 0, 0x62]))).toBe(false);
  });
});
