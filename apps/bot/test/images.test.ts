import { crc32 } from "node:zlib";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from "@eidolon/chat";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import {
  fittedSize,
  MAX_SENT_IMAGE_PIXELS,
  type NormalizedImage,
  normalizeImage,
} from "../src/images.ts";

function canvas(width: number, height: number, alpha = false) {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 200, g: 40, b: 40, alpha: 0.5 } : "#c82828",
    },
  });
}

/** Gaussian noise, which compresses as little as an image can. */
function noise(width: number, height: number) {
  const pixels = { type: "gaussian", mean: 128, sigma: 60 } as const;
  return sharp({ create: { width, height, channels: 3, background: "#000", noise: pixels } });
}

/** `jpeg` with an APP`n` segment holding `payload`, after its start. */
function withSegment(jpeg: Buffer, n: number, payload: Buffer): Buffer {
  const length = payload.byteLength + 2;
  const marker = Buffer.from([0xff, 0xe0 + n, length >> 8, length & 0xff]);
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
}

/** EXIF naming the camera "cat" and nothing else, no orientation included. */
const CAMERA = Buffer.concat([
  Buffer.from("Exif\0\0", "latin1"),
  Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x0f, 0x01, 2, 0, 4, 0, 0, 0]),
  Buffer.from("cat\0\0\0\0\0", "latin1"),
]);

/** Photoshop's IPTC, captioned "a cat". */
const CAPTION = Buffer.concat([
  Buffer.from("Photoshop 3.0\x008BIM\x04\x04\x00\x00\x00\x00\x00\x0a", "latin1"),
  Buffer.from("\x1c\x02\x78\0\x05a cat", "latin1"),
]);

/**
 * `png` with a text chunk, as a generator writes its prompt in one: after its header, or else
 * after its pixels, where reading the header never reaches.
 */
function withText(png: Buffer, where: "head" | "tail", text: string): Buffer {
  const body = Buffer.from(`tEXtparameters\0${text}`, "latin1");
  const chunk = Buffer.alloc(body.byteLength + 8);
  chunk.writeUInt32BE(body.byteLength - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.byteLength + 4);
  // The signature and IHDR, or all but IEND.
  const at = where === "head" ? 33 : png.byteLength - 12;
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(at)]);
}

/** The colour of the pixel at `x`, `y`: "red", "blue" or something else. */
async function colourAt(bytes: Uint8Array, x: number, y: number): Promise<string> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  const [r, g, b] = [data[at], data[at + 1], data[at + 2]] as number[];
  if ((r as number) > 150 && (g as number) < 90 && (b as number) < 90) return "red";
  return (b as number) > 150 && (r as number) < 90 ? "blue" : `rgb(${r}, ${g}, ${b})`;
}

async function made(bytes: Uint8Array, maxPixels = MAX_SENT_IMAGE_PIXELS) {
  const result = await normalizeImage(bytes, maxPixels);
  if ("refused" in result) throw new Error(`refused as ${result.refused}`);
  return { ...result, meta: await sharp(result.bytes).metadata() };
}

describe("normalizeImage", () => {
  test("an image already clean, whole and in bounds goes as it is", async () => {
    const png = await canvas(8, 8, true).png().toBuffer();
    const kept = (await normalizeImage(png, MAX_SENT_IMAGE_PIXELS)) as NormalizedImage;
    expect(kept.mime).toBe("image/png");
    expect(Buffer.from(kept.bytes).equals(png)).toBe(true);
  });

  test("a camera's photo is turned upright, and what the camera wrote in it goes", async () => {
    // Stored red on the left and blue on the right, to be shown turned a quarter clockwise.
    const halves = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#e00000" },
    })
      .extend({ right: 20, background: "#0000e0" })
      .png()
      .toBuffer();
    const sideways = await sharp(halves)
      .jpeg()
      .withExif({ IFD0: { Make: "camera" } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const upright = await made(sideways);
    expect(upright.mime).toBe("image/jpeg");
    expect([upright.meta.width, upright.meta.height]).toEqual([20, 40]);
    expect([upright.meta.exif, upright.meta.orientation]).toEqual([undefined, undefined]);
    expect([await colourAt(upright.bytes, 15, 5), await colourAt(upright.bytes, 5, 35)]).toEqual([
      "red",
      "blue",
    ]);
  });

  test("anything written in an image makes it again, wherever its kind keeps it", async () => {
    const jpeg = await canvas(8, 8).jpeg().toBuffer();
    const png = await canvas(8, 8, true).png().toBuffer();
    const written = {
      exif: withSegment(jpeg, 1, CAMERA),
      xmp: await canvas(8, 8)
        .jpeg()
        .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF about="a cat"/></x:xmpmeta>')
        .toBuffer(),
      iptc: withSegment(jpeg, 13, CAPTION),
      icc: await canvas(8, 8, true).webp().withIccProfile("p3").toBuffer(),
      "png text": withText(png, "head", "a cat"),
      "png text after its pixels": withText(png, "tail", "a cat"),
    };
    const camera = await sharp(written.exif).metadata();
    expect([camera.exif === undefined, camera.orientation]).toEqual([false, undefined]);
    expect((await sharp(written.iptc).metadata()).iptc).toBeDefined();
    for (const [kind, bytes] of Object.entries(written)) {
      const plain = await made(bytes);
      const { exif, xmp, iptc, hasProfile, comments } = plain.meta;
      expect([kind, exif, xmp, iptc, hasProfile, comments]).toEqual([
        kind,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
      ]);
      expect([kind, Buffer.from(plain.bytes).includes("cat")]).toEqual([kind, false]);
    }
  });

  test("an image with transparency goes as WebP, and one in another colour space as sRGB", async () => {
    const profiled = await canvas(16, 16, true).png().withIccProfile("p3").toBuffer();
    const webp = await made(profiled);
    expect(webp.mime).toBe("image/webp");
    expect(webp.meta).toMatchObject({ format: "webp", hasAlpha: true, hasProfile: false });
    expect((await made(await canvas(16, 16).jpeg().toBuffer())).mime).toBe("image/jpeg");
    const deep = await canvas(16, 16).toColourspace("rgb16").png().toBuffer();
    const jpeg = await made(deep);
    expect(jpeg.mime).toBe("image/jpeg");
    expect(jpeg.meta).toMatchObject({ format: "jpeg", space: "srgb", depth: "uchar" });
    const grey = await canvas(16, 16).toColourspace("b-w").png().toBuffer();
    expect((await made(grey)).meta).toMatchObject({ format: "jpeg", space: "srgb", channels: 3 });
  });

  test("one past MAX_IMAGE_BYTES goes again, at the first quality that fits", async () => {
    const png = await noise(2048, 1024).png().toBuffer();
    expect(png.byteLength).toBeGreaterThan(MAX_IMAGE_BYTES);
    const fitted = await made(png);
    expect([fitted.mime, fitted.meta.width, fitted.meta.height]).toEqual([
      "image/jpeg",
      2048,
      1024,
    ]);
    expect(fitted.bytes.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  });

  test("one past MAX_IMAGE_PIXELS or MAX_IMAGE_EDGE is scaled down to fit", async () => {
    const photo = await made(await canvas(3000, 2000).jpeg().toBuffer());
    expect([photo.meta.width, photo.meta.height]).toEqual([2508, 1672]);
    const strip = await made(await canvas(6000, 500).png().toBuffer());
    expect([strip.meta.width, strip.meta.height]).toEqual([MAX_IMAGE_EDGE, 214]);
  });

  test("a GIF goes as WebP, and an animated GIF or WebP as its first frame", async () => {
    const plain = await canvas(4, 4).gif().toBuffer();
    expect((await made(plain)).mime).toBe("image/webp");
    const frame = (background: string) =>
      sharp({ create: { width: 4, height: 6, channels: 3, background } })
        .png()
        .toBuffer();
    const frames = [await frame("#e00000"), await frame("#0000e0")];
    for (const animated of [
      await sharp(frames, { join: { animated: true } })
        .gif()
        .toBuffer(),
      await sharp(frames, { join: { animated: true } })
        .webp()
        .toBuffer(),
    ]) {
      expect((await sharp(animated).metadata()).pages).toBe(2);
      const still = await made(animated);
      expect([still.meta.pages ?? 1, still.meta.height]).toEqual([1, 6]);
      expect(await colourAt(still.bytes, 2, 3)).toBe("red");
    }
  });

  test("refuses what isn't a whole PNG, JPEG, WebP or GIF, and one past its pixels", async () => {
    // Noise, so the cut falls in the pixels and the header still reads.
    const jpeg = await noise(64, 64).jpeg().toBuffer();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4"/>');
    const pdf = new TextEncoder().encode("%PDF-1.7\n");
    for (const bytes of [jpeg.subarray(0, jpeg.byteLength / 2), svg, pdf, new Uint8Array()]) {
      expect(await normalizeImage(bytes, MAX_SENT_IMAGE_PIXELS)).toEqual({
        refused: "unsupported",
      });
    }
    const big = await canvas(2049, 2048).png().toBuffer();
    expect(await normalizeImage(big, MAX_IMAGE_PIXELS)).toEqual({ refused: "too-large" });
    expect((await made(big)).meta.width).toBe(2048);
  });
});

describe("fittedSize", () => {
  test("keeps an image in bounds, and scales one down, never past them", () => {
    expect(fittedSize(1170, 2532)).toEqual({ width: 1170, height: 2532 });
    expect(fittedSize(4032, 3024)).toEqual({ width: 2364, height: 1773 });
    expect(fittedSize(6000, 1000)).toEqual({ width: 2576, height: 429 });
    for (const [width, height] of [
      [4032, 3024],
      [2049, 2048],
      [12_345, 6789],
    ] as const) {
      const fitted = fittedSize(width, height);
      expect(fitted.width * fitted.height).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
      expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    }
  });
});
