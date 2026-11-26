// Notification avatars: 256x256 circular PNGs, transparent cutouts in group composites, EXIF
// orientation, silhouette fallback, ETag / 304, and Bearer/proof authentication.
import "../../../../packages/config/test/isolated-guard.ts";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { personaHomeDir } from "@eidolon/config";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearNotificationAvatarCache } from "../../src/local/notification-avatar.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot } from "./harness.ts";

const MILKY = "milky-green";

let booted: Booted;
let logs: CapturedLogs;

beforeEach(async () => {
  clearNotificationAvatarCache();
  logs = captureLogs();
  booted = await bootFixture();
});

afterEach(async () => {
  clearNotificationAvatarCache();
  await booted.stop();
  logs.restore();
  cleanUpBoot();
});

async function solidPng(r: number, g: number, b: number, a = 255, size = 128): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: a / 255 } },
  })
    .png()
    .toBuffer();
}

function saveAvatar(persona: string, filename: string, bytes: Uint8Array): void {
  const dir = personaHomeDir(persona);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
}

async function decodeRgba(
  bytes: Uint8Array,
): Promise<{ readonly data: Uint8Array; readonly width: number; readonly height: number }> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

function pixelAt(
  rgba: { readonly data: Uint8Array; readonly width: number },
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * rgba.width + x) * 4;
  return [
    rgba.data[i] as number,
    rgba.data[i + 1] as number,
    rgba.data[i + 2] as number,
    rgba.data[i + 3] as number,
  ];
}

describe("GET /api/local/personas/:id/notification-avatar", () => {
  test("requires Bearer or session+proof (never cookie alone) and serves ETag 304", async () => {
    saveAvatar(MILKY, "avatar.png", await solidPng(20, 180, 90));
    const url = `${booted.base}/api/local/personas/${MILKY}/notification-avatar`;

    const cookieOnly = await fetch(url, { headers: { Cookie: booted.cookie } });
    expect(cookieOnly.status).toBe(401);
    expect((await cookieOnly.json()).error.code).toBe("proof-missing");

    const bearer = await fetch(url, {
      headers: { Authorization: `Bearer ${booted.token.secret}` },
    });
    expect(bearer.status).toBe(200);
    expect(bearer.headers.get("content-type")).toBe("image/png");
    expect(bearer.headers.get("cache-control")).toBe("no-store");
    const etag = bearer.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const bytes = new Uint8Array(await bearer.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(etag).toBe(`"${sha}"`);

    const notModified = await fetch(url, {
      headers: { ...booted.session, "If-None-Match": etag as string },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    expect(await notModified.text()).toBe("");

    const wildcard = await fetch(url, {
      headers: { ...booted.session, "If-None-Match": "*" },
    });
    expect(wildcard.status).toBe(304);
    expect(wildcard.headers.get("etag")).toBe(etag);
    expect(await wildcard.text()).toBe("");
  });

  test("renders single circular PNG, respects EXIF orientation, and keeps transparent cutouts", async () => {
    // Upper half red, lower half blue, rotated with EXIF orientation 6 (90 deg CW -> red on right).
    const raw = Buffer.alloc(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const top = y < 32;
        raw[i] = top ? 230 : 20;
        raw[i + 1] = 20;
        raw[i + 2] = top ? 20 : 230;
        raw[i + 3] = 255;
      }
    }
    const jpeg = await sharp(raw, { raw: { width: 64, height: 64, channels: 4 } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    saveAvatar(MILKY, "avatar.jpg", jpeg);

    const res = await fetch(`${booted.base}/api/local/personas/${MILKY}/notification-avatar`, {
      headers: { Authorization: `Bearer ${booted.token.secret}` },
    });
    expect(res.status).toBe(200);
    const decoded = await decodeRgba(new Uint8Array(await res.arrayBuffer()));
    expect([decoded.width, decoded.height]).toEqual([256, 256]);
    expect(pixelAt(decoded, 0, 0)[3]).toBe(0);
    expect(pixelAt(decoded, 255, 255)[3]).toBe(0);
    // Right side came from top (red); left side came from bottom (blue).
    expect(pixelAt(decoded, 190, 128)[0]).toBeGreaterThan(180);
    expect(pixelAt(decoded, 190, 128)[2]).toBeLessThan(60);
    expect(pixelAt(decoded, 64, 128)[2]).toBeGreaterThan(180);
    expect(pixelAt(decoded, 64, 128)[0]).toBeLessThan(60);

    // Replace with a PNG that has a transparent hole in the center; cache invalidates and hole stays.
    const hole = Buffer.alloc(128 * 128 * 4);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const i = (y * 128 + x) * 4;
        const insideHole = Math.hypot(x - 63.5, y - 63.5) < 20;
        hole[i] = 30;
        hole[i + 1] = 200;
        hole[i + 2] = 60;
        hole[i + 3] = insideHole ? 0 : 255;
      }
    }
    rmSync(join(personaHomeDir(MILKY), "avatar.jpg"), { force: true });
    saveAvatar(
      MILKY,
      "avatar.png",
      await sharp(hole, { raw: { width: 128, height: 128, channels: 4 } })
        .png()
        .toBuffer(),
    );

    const res2 = await fetch(`${booted.base}/api/local/personas/${MILKY}/notification-avatar`, {
      headers: { Authorization: `Bearer ${booted.token.secret}` },
    });
    const decoded2 = await decodeRgba(new Uint8Array(await res2.arrayBuffer()));
    expect(pixelAt(decoded2, 128, 128)[3]).toBe(0);
    expect(pixelAt(decoded2, 128, 50)[3]).toBe(255);
  });

  test("falls back to a neutral silhouette disc for a persona without an avatar or deleted id", async () => {
    const res = await fetch(`${booted.base}/api/local/personas/former-member/notification-avatar`, {
      headers: { Authorization: `Bearer ${booted.token.secret}` },
    });
    expect(res.status).toBe(200);
    const decoded = await decodeRgba(new Uint8Array(await res.arrayBuffer()));
    expect([decoded.width, decoded.height]).toEqual([256, 256]);
    expect(pixelAt(decoded, 0, 0)[3]).toBe(0);
    expect(pixelAt(decoded, 128, 128)[3]).toBe(255);
    expect(pixelAt(decoded, 128, 95)[0]).toBeGreaterThan(200);
  });

  test("composites speaker with 1 or 2 group peers, transparent punch-out rings, and clear bottom-right", async () => {
    saveAvatar(MILKY, "avatar.png", await solidPng(220, 40, 40));
    saveAvatar(
      "peer-one",
      "avatar.webp",
      await sharp(await solidPng(40, 200, 60))
        .webp()
        .toBuffer(),
    );
    saveAvatar("peer-two", "avatar.png", await solidPng(40, 80, 220));

    // 2-persona composite
    const two = await fetch(
      `${booted.base}/api/local/personas/${MILKY}/notification-avatar?group=peer-one`,
      { headers: { Authorization: `Bearer ${booted.token.secret}` } },
    );
    expect(two.status).toBe(200);
    const twoRgba = await decodeRgba(new Uint8Array(await two.arrayBuffer()));
    // Speaker center (99, 155) is red; peer1 center (187, 67) is green.
    expect(pixelAt(twoRgba, 99, 155)).toEqual([220, 40, 40, 255]);
    expect(pixelAt(twoRgba, 187, 67)).toEqual([40, 200, 60, 255]);
    // Point inside peer1's circle AND inside speaker's 8px punch-out ring (92 < dist < 100) is transparent.
    expect(pixelAt(twoRgba, 167, 88)[3]).toBe(0);
    // Bottom-right badge corner stays transparent.
    expect(pixelAt(twoRgba, 225, 225)[3]).toBe(0);

    // 3-persona composite (+ deduplication and self-exclusion)
    const three = await fetch(
      `${booted.base}/api/local/personas/${MILKY}/notification-avatar?group=${MILKY},peer-one,peer-one,peer-two,peer-three`,
      { headers: { Authorization: `Bearer ${booted.token.secret}` } },
    );
    const canonical = await fetch(
      `${booted.base}/api/local/personas/${MILKY}/notification-avatar?group=peer-one,peer-two`,
      { headers: { Authorization: `Bearer ${booted.token.secret}` } },
    );
    expect(three.status).toBe(200);
    expect(three.headers.get("etag")).toBe(canonical.headers.get("etag"));
    const threeRgba = await decodeRgba(new Uint8Array(await three.arrayBuffer()));
    expect(pixelAt(threeRgba, 97, 157)).toEqual([220, 40, 40, 255]);
    expect(pixelAt(threeRgba, 189, 65)).toEqual([40, 200, 60, 255]);
    expect(pixelAt(threeRgba, 63, 55)).toEqual([40, 80, 220, 255]);
    // Point inside peer2's circle AND inside speaker's 8px punch-out ring (90 < dist < 98) is transparent.
    expect(pixelAt(threeRgba, 68, 68)[3]).toBe(0);
    expect(pixelAt(threeRgba, 225, 225)[3]).toBe(0);
  });

  test("rejects invalid persona ids and invalid group lists", async () => {
    expect(
      (
        await fetch(`${booted.base}/api/local/personas/BadId/notification-avatar`, {
          headers: booted.session,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${booted.base}/api/local/personas/${MILKY}/notification-avatar?group=BadId`, {
          headers: booted.session,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${booted.base}/api/local/personas/${MILKY}/notification-avatar?group=a,b,c,d,e,f,g`,
          { headers: booted.session },
        )
      ).status,
    ).toBe(400);
  });

  test("falls back to silhouette when an avatar exceeds MAX_SENT_IMAGE_PIXELS", async () => {
    const oversized = await sharp({
      create: {
        width: 8500,
        height: 8500,
        channels: 3,
        background: { r: 220, g: 40, b: 40 },
      },
    })
      .png({ compressionLevel: 1 })
      .toBuffer();
    saveAvatar(MILKY, "avatar.png", oversized);

    const res = await fetch(`${booted.base}/api/local/personas/${MILKY}/notification-avatar`, {
      headers: { Authorization: `Bearer ${booted.token.secret}` },
    });
    expect(res.status).toBe(200);
    const decoded = await decodeRgba(new Uint8Array(await res.arrayBuffer()));
    // Neutral silhouette head is light grey rather than the uploaded image's red.
    expect(pixelAt(decoded, 128, 95)[0]).toBeGreaterThan(200);
    expect(pixelAt(decoded, 128, 95)[1]).toBeGreaterThan(200);
  });
});
