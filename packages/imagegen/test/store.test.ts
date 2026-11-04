import { describe, expect, test } from "bun:test";
import {
  type GeneratedImage,
  imageSuffix,
  SELFIE_PATH,
  SelfieStore,
  selfieResponse,
  selfieStore,
} from "../src/index.ts";
import { SUFFIXES } from "./goldens.ts";

const PNG: GeneratedImage = { data: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" };

function clock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance(seconds: number) {
      now += seconds;
    },
  };
}

function idOf(url: string): string {
  return url.slice(`${SELFIE_PATH}/`.length).replace(/\.[^.]+$/, "");
}

describe("SelfieStore.publish", () => {
  test("mints 22-character base64url ids under /api/selfie with the type's suffix", () => {
    const store = new SelfieStore();
    const urls = [
      store.publish(PNG, 600),
      store.publish({ data: new Uint8Array(1), mediaType: "image/jpeg" }, 600),
      store.publish({ data: new Uint8Array(1), mediaType: "image/webp" }, 600),
      store.publish({ data: new Uint8Array(1), mediaType: "image/x-foo" }, 600),
    ];
    for (const url of urls) expect(url).toMatch(/^\/api\/selfie\/[A-Za-z0-9_-]{22}\.[a-z]+$/);
    expect(urls.map((url) => url.slice(url.lastIndexOf(".")))).toEqual([
      ".png",
      ".jpg",
      ".webp",
      ".png",
    ]);
    expect(new Set(urls.map(idOf)).size).toBe(4);
  });

  test("uses the injected id source", () => {
    const store = new SelfieStore({ newId: () => "fixed-id" });
    expect(store.publish(PNG, 600)).toBe("/api/selfie/fixed-id.png");
  });

  test("sweeps expired entries on every publish", () => {
    const time = clock();
    let n = 0;
    const store = new SelfieStore({ now: time.now, newId: () => `id${n++}` });
    store.publish(PNG, 10);
    store.publish(PNG, 20);
    expect(store.size).toBe(2);
    time.advance(10);
    store.publish(PNG, 600);
    expect(store.size).toBe(2);
    expect(store.lookup("id0.png")).toBeNull();
    expect(store.lookup("id1.png")).toEqual(PNG);
  });
});

describe("SelfieStore.lookup", () => {
  test("ignores one extension, so any suffix or none finds the entry", () => {
    const store = new SelfieStore({ newId: () => "abc" });
    store.publish(PNG, 600);
    expect(store.lookup("abc.png")).toEqual(PNG);
    expect(store.lookup("abc.jpg")).toEqual(PNG);
    expect(store.lookup("abc")).toEqual(PNG);
    expect(store.lookup("abc.png.png")).toBeNull();
    expect(store.lookup("nope.png")).toBeNull();
  });

  test("misses and evicts at exactly the expiry instant", () => {
    const time = clock();
    const store = new SelfieStore({ now: time.now, newId: () => "abc" });
    store.publish(PNG, 600);
    time.advance(599.5);
    expect(store.lookup("abc.png")).toEqual(PNG);
    time.advance(0.5);
    expect(store.lookup("abc.png")).toBeNull();
    expect(store.size).toBe(0);
  });

  test("a TTL of zero or less is dead on arrival", () => {
    const store = new SelfieStore({ now: () => 5, newId: () => "abc" });
    store.publish(PNG, 0);
    expect(store.lookup("abc.png")).toBeNull();
    store.publish(PNG, -1);
    expect(store.lookup("abc")).toBeNull();
  });
});

describe("selfieResponse", () => {
  test("serves the bytes with their media type, and a bare 404 otherwise", async () => {
    const store = new SelfieStore({ newId: () => "abc" });
    store.publish({ data: PNG.data, mediaType: "image/webp" }, 600);
    const hit = selfieResponse("abc.png", store);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-type")).toBe("image/webp");
    expect([...new Uint8Array(await hit.arrayBuffer())]).toEqual([...PNG.data]);
    const miss = selfieResponse("nope.png", store);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("content-type")).toBeNull();
    expect(await miss.text()).toBe("");
  });

  test("goes out under Bun.serve with Python's headers", async () => {
    const store = new SelfieStore({ newId: () => "abc" });
    store.publish(PNG, 600);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: { "/api/selfie/:id": { GET: (req) => selfieResponse(req.params.id, store) } },
      fetch: () => new Response("unrouted", { status: 500 }),
    });
    try {
      const hit = await fetch(`http://127.0.0.1:${server.port}/api/selfie/abc.png`);
      expect([
        hit.status,
        hit.headers.get("content-type"),
        hit.headers.get("content-length"),
      ]).toEqual([200, "image/png", "4"]);
      await hit.arrayBuffer();
      const miss = await fetch(`http://127.0.0.1:${server.port}/api/selfie/nope.png`);
      expect([
        miss.status,
        miss.headers.get("content-type"),
        miss.headers.get("content-length"),
      ]).toEqual([404, null, "0"]);
      expect(await miss.text()).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("defaults to the process-wide store", () => {
    const url = selfieStore.publish(PNG, 600);
    expect(selfieResponse(url.slice(`${SELFIE_PATH}/`.length)).status).toBe(200);
    expect(selfieStore.lookup(idOf(url))).toEqual(PNG);
  });
});

describe("imageSuffix", () => {
  test("matches GeneratedImage.suffix", () => {
    // mimetypes.guess_extension without the host's mime.types files, as in the container.
    const others = {
      "application/json": ".json",
      "Text/HTML": ".html",
      "application/octet-stream": ".bin",
      "video/mp4": ".mp4",
      "image/x-icon": ".png",
      "message/rfc822": ".eml",
    };
    for (const [mediaType, suffix] of Object.entries({ ...SUFFIXES, ...others })) {
      expect([mediaType, imageSuffix(mediaType)]).toEqual([mediaType, suffix]);
    }
  });
});
