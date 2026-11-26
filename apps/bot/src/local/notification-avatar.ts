// Notification avatars for the desktop app: 256x256 circular PNGs of a persona alone or leading
// up to two peers from a group chat, rendered directly in RGBA pixel buffers with sharp.
import { hash } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { MAX_SENT_IMAGE_PIXELS } from "../images.ts";
import { findAvatar } from "./personas.ts";

const SIZE = 256;
const SLOTS = 2;
const CACHE_LIMIT = 64;

type Sharp = typeof import("sharp")["default"];

export interface NotificationAvatar {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sha256: string;
}

interface FaceSlot {
  readonly index: number;
  readonly diameter: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly punch: number;
}

const LAYOUTS: readonly (readonly FaceSlot[])[] = [
  [{ index: 0, diameter: SIZE, x: SIZE / 2, y: SIZE / 2, radius: 124, punch: 0 }],
  [
    { index: 1, diameter: 120, x: 188, y: 68, radius: 60, punch: 0 },
    { index: 0, diameter: 184, x: 100, y: 156, radius: 92, punch: 8 },
  ],
  [
    { index: 2, diameter: 96, x: 64, y: 56, radius: 48, punch: 0 },
    { index: 1, diameter: 116, x: 190, y: 66, radius: 58, punch: 7 },
    { index: 0, diameter: 180, x: 98, y: 158, radius: 90, punch: 8 },
  ],
];

let loaded: Promise<Sharp> | undefined;

function loadSharp(): Promise<Sharp> {
  loaded ??= import("sharp").then((module) => module.default);
  return loaded;
}

let running = 0;
const waiting: (() => void)[] = [];

async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running < SLOTS) running += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  }
}

const cache = new Map<string, NotificationAvatar>();
const inflight = new Map<string, Promise<NotificationAvatar>>();
const silhouettes = new Map<number, Uint8Array>();

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** Neutral zinc silhouette disc when a persona has no avatar picture or it fails to decode. */
function silhouetteFace(diameter: number): Uint8Array {
  const cached = silhouettes.get(diameter);
  if (cached !== undefined) return cached;

  const rgba = new Uint8Array(diameter * diameter * 4);
  const center = (diameter - 1) / 2;
  const discR = diameter / 2;
  const headY = 0.37 * diameter;
  const headR = 0.175 * diameter;
  const shoulderY = 0.86 * diameter;
  const rx = 0.33 * diameter;
  const ry = 0.27 * diameter;

  for (let y = 0; y < diameter; y++) {
    for (let x = 0; x < diameter; x++) {
      const dist = Math.hypot(x - center, y - center);
      const discMask = clamp01(discR + 0.5 - dist);
      if (discMask === 0) continue;

      const headMask = clamp01(headR + 0.5 - Math.hypot(x - center, y - headY));
      const dx = (x - center) / rx;
      const dy = (y - shoulderY) / ry;
      const u = Math.hypot(dx, dy);
      let shoulderMask: number;
      if (u === 0) shoulderMask = 1;
      else {
        const grad = Math.hypot(dx / rx, dy / ry) / u;
        shoulderMask = clamp01(0.5 + (1 - u) / grad);
      }

      const fg = Math.max(headMask, shoulderMask);
      const offset = (y * diameter + x) * 4;
      rgba[offset] = Math.round(82 * (1 - fg) + 244 * fg);
      rgba[offset + 1] = Math.round(82 * (1 - fg) + 244 * fg);
      rgba[offset + 2] = Math.round(91 * (1 - fg) + 245 * fg);
      rgba[offset + 3] = Math.round(255 * discMask);
    }
  }
  silhouettes.set(diameter, rgba);
  return rgba;
}

async function loadFace(diameter: number, avatarPath: string | null): Promise<Uint8Array> {
  if (avatarPath === null) return silhouetteFace(diameter);
  try {
    const file = await readFile(avatarPath);
    const sharp = await loadSharp();
    const { data, info } = await inSlot(() =>
      // Match attachment pixel cap (64 MP) so absurdly large headers fall back to silhouette.
      sharp(file, { failOn: "error", limitInputPixels: MAX_SENT_IMAGE_PIXELS, autoOrient: true })
        .resize(diameter, diameter, { fit: "cover" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    );
    if (info.width === diameter && info.height === diameter && info.channels === 4) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
  } catch {
    // Fall back to a silhouette if the avatar file disappeared or fails to decode.
  }
  return silhouetteFace(diameter);
}

/**
 * Punches a transparent ring out of `canvas` around `(cx, cy)` when `punchRingPx > 0`, then
 * masks `face` to a circle of `radius` and alpha-over blends it onto `canvas`.
 */
function placeCircle(
  canvas: Uint8Array,
  face: Uint8Array,
  diameter: number,
  targetX: number,
  targetY: number,
  radius: number,
  punchRingPx: number,
): void {
  const left = Math.round(targetX - diameter / 2);
  const top = Math.round(targetY - diameter / 2);
  const cx = left + (diameter - 1) / 2;
  const cy = top + (diameter - 1) / 2;

  if (punchRingPx > 0) {
    const cutR = radius + punchRingPx;
    const minX = Math.max(0, Math.floor(cx - cutR - 1));
    const maxX = Math.min(SIZE - 1, Math.ceil(cx + cutR + 1));
    const minY = Math.max(0, Math.floor(cy - cutR - 1));
    const maxY = Math.min(SIZE - 1, Math.ceil(cy + cutR + 1));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        const keep = clamp01(dist - (cutR - 0.5));
        if (keep >= 1) continue;
        const idx = (y * SIZE + x) * 4;
        const nextAlpha = Math.round((canvas[idx + 3] as number) * keep);
        canvas[idx + 3] = nextAlpha;
        if (nextAlpha === 0) {
          canvas[idx] = 0;
          canvas[idx + 1] = 0;
          canvas[idx + 2] = 0;
        }
      }
    }
  }

  for (let fy = 0; fy < diameter; fy++) {
    const py = top + fy;
    if (py < 0 || py >= SIZE) continue;
    for (let fx = 0; fx < diameter; fx++) {
      const px = left + fx;
      if (px < 0 || px >= SIZE) continue;
      const dist = Math.hypot(px - cx, py - cy);
      const mask = clamp01(radius + 0.5 - dist);
      if (mask === 0) continue;

      const sIdx = (fy * diameter + fx) * 4;
      const sa = ((face[sIdx + 3] as number) * mask) / 255;
      if (sa <= 0) continue;

      const dIdx = (py * SIZE + px) * 4;
      const da = (canvas[dIdx + 3] as number) / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;

      const sr = face[sIdx] as number;
      const sg = face[sIdx + 1] as number;
      const sb = face[sIdx + 2] as number;
      const dr = canvas[dIdx] as number;
      const dg = canvas[dIdx + 1] as number;
      const db = canvas[dIdx + 2] as number;

      canvas[dIdx] = Math.round((sr * sa + dr * da * (1 - sa)) / outA);
      canvas[dIdx + 1] = Math.round((sg * sa + dg * da * (1 - sa)) / outA);
      canvas[dIdx + 2] = Math.round((sb * sa + db * da * (1 - sa)) / outA);
      canvas[dIdx + 3] = Math.round(outA * 255);
    }
  }
}

function avatarStamp(id: string): { readonly path: string | null; readonly stamp: string } {
  const found = findAvatar(id);
  if (found === null) return { path: null, stamp: "none" };
  try {
    const stat = statSync(found.path);
    return { path: found.path, stamp: `${found.path}:${stat.size}:${Math.trunc(stat.mtimeMs)}` };
  } catch {
    return { path: null, stamp: "none" };
  }
}

function canonicalPeers(speakerId: string, rawPeers: readonly string[]): string[] {
  const peers: string[] = [];
  for (const peer of rawPeers) {
    if (peer !== speakerId && !peers.includes(peer)) peers.push(peer);
    if (peers.length === 2) break;
  }
  return peers;
}

async function renderNotificationAvatar(
  key: string,
  resolved: readonly { readonly path: string | null; readonly stamp: string }[],
  peerCount: number,
): Promise<NotificationAvatar> {
  const canvas = new Uint8Array(SIZE * SIZE * 4);
  const layout = LAYOUTS[peerCount] ?? LAYOUTS[0]!;
  const faces = await Promise.all(
    layout.map((slot) => loadFace(slot.diameter, resolved[slot.index]!.path)),
  );
  for (const [index, slot] of layout.entries()) {
    placeCircle(canvas, faces[index]!, slot.diameter, slot.x, slot.y, slot.radius, slot.punch);
  }

  const sharp = await loadSharp();
  const png = await inSlot(() =>
    sharp(canvas, { raw: { width: SIZE, height: SIZE, channels: 4 } })
      .png()
      .toBuffer(),
  );
  const bytes = new Uint8Array(png.buffer as ArrayBuffer, png.byteOffset, png.byteLength);
  const entry: NotificationAvatar = {
    bytes,
    sha256: hash("sha256", bytes, "hex"),
  };

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
  return entry;
}

/**
 * Renders a 256x256 circular transparent PNG for `speakerId`, or a group composite with up to two
 * `peers` behind the speaker, keeping the bottom-right corner clear for macOS's app-icon badge.
 */
export async function notificationAvatar(
  speakerId: string,
  peers: readonly string[] = [],
): Promise<NotificationAvatar> {
  const peerIds = canonicalPeers(speakerId, peers);
  const resolved = [speakerId, ...peerIds].map((id) => avatarStamp(id));
  const key = `${speakerId}|${peerIds.join(",")}|${resolved.map((item) => item.stamp).join("|")}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const pending = inflight.get(key);
  if (pending !== undefined) return pending;

  const render = renderNotificationAvatar(key, resolved, peerIds.length).finally(() => {
    if (inflight.get(key) === render) inflight.delete(key);
  });
  inflight.set(key, render);
  return render;
}

/** Clears the in-memory notification avatar cache; intended for tests. */
export function clearNotificationAvatarCache(): void {
  cache.clear();
  inflight.clear();
}
