import { describe, expect, test } from "bun:test";
import { SelfieStore } from "@eidolon/imagegen";
import { fetchStoredSelfie, saveSelfies } from "../src/attachments.ts";

describe("fetchStoredSelfie", () => {
  test("reads a published selfie's bytes from the store", async () => {
    let now = 0;
    const store = new SelfieStore({ now: () => now, newId: () => "abc" });
    const data = new Uint8Array([1, 2, 3]);
    const url = store.publish({ data, mediaType: "image/png" }, 600);
    expect(url).toBe("/api/selfie/abc.png");
    expect(await fetchStoredSelfie(url, store)).toEqual({ bytes: data, mime: "image/png" });

    now = 600;
    await expect(fetchStoredSelfie(url, store)).rejects.toThrow(
      "The selfie at /api/selfie/abc.png is gone",
    );
  });

  test("refuses a URL outside the selfie store", async () => {
    await expect(fetchStoredSelfie("https://example.com/a.png", new SelfieStore())).rejects.toThrow(
      "Not a selfie URL",
    );
  });
});

describe("saveSelfies", () => {
  const deps = {
    fetchImage: async (url: string) => ({
      bytes: new TextEncoder().encode(url),
      mime: "image/webp",
    }),
    saveAttachment: async (bytes: Uint8Array, mime: string) =>
      ({ kind: "image", name: new TextDecoder().decode(bytes), mime }) as const,
  };

  test("saves each image a selfie message names, in order", async () => {
    const saved = await saveSelfies(
      { type: "selfie", urls: ["/api/selfie/a.webp", 7, "/api/selfie/b.webp"] },
      new AbortController().signal,
      deps,
    );
    expect(saved).toEqual([
      { kind: "image", name: "/api/selfie/a.webp", mime: "image/webp" },
      { kind: "image", name: "/api/selfie/b.webp", mime: "image/webp" },
    ]);
  });

  test("keeps nothing from any other message", async () => {
    const signal = new AbortController().signal;
    expect(await saveSelfies({ type: "voice", urls: ["/x"] }, signal, deps)).toEqual([]);
    expect(await saveSelfies({ type: "selfie" }, signal, deps)).toEqual([]);
  });
});
