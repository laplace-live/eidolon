import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type ReferenceImage,
  type RenderSelfieOptions,
  renderSelfie,
  SelfieStore,
} from "../src/index.ts";
import {
  bytesOf,
  CancelledError,
  captureLogs,
  clearSelfieEnv,
  dataUrl,
  fakeFetch,
  hangingFetch,
  jsonResponse,
  logLines,
  removeTempDirs,
  restoreEnv,
  restoreLogs,
  setEnv,
  tempTree,
} from "./helpers.ts";

const B64 = "iVBORyBmYWtl";
const NIGHT = { hour: 22, minute: 0 };

let root: string;

beforeEach(() => {
  clearSelfieEnv();
  root = tempTree({ "outfits/day.png": bytesOf("day"), "outfits/night.png": bytesOf("night") });
});
afterEach(() => {
  restoreEnv();
  restoreLogs();
});
afterAll(removeTempDirs);

function options(overrides: Partial<RenderSelfieOptions>): RenderSelfieOptions {
  return {
    apiKey: "sk-test",
    model: "openai/gpt-image-2.5-flare",
    aspectRatio: "3:4",
    quality: "auto",
    ttlSeconds: 600,
    prompt: "a selfie",
    root,
    clock: NIGHT,
    store: new SelfieStore(),
    ...overrides,
  };
}

const friend = (label: string): ReferenceImage => ({
  type: "image_url",
  image_url: { url: `https://friends/${label}.png` },
});

function referencesSent(payload: Record<string, unknown>): string[] {
  return (payload.input_references as ReferenceImage[]).map((reference) => reference.image_url.url);
}

describe("renderSelfie", () => {
  test("sends this hour's outfit first, then the friends, with the bot's settings", async () => {
    captureLogs();
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { data: [{ b64_json: B64 }] }));
    await renderSelfie(options({ fetch, extraReferences: [friend("A"), friend("B")] }));
    const payload = calls[0]?.payload ?? {};
    expect(Object.keys(payload)).toEqual([
      "model",
      "prompt",
      "n",
      "input_references",
      "aspect_ratio",
    ]);
    expect(payload.n).toBe(1);
    expect(referencesSent(payload)).toEqual([
      dataUrl("image/png", bytesOf("night")),
      "https://friends/A.png",
      "https://friends/B.png",
    ]);
  });

  test("caps the references at 16, dropping the last friends", async () => {
    captureLogs();
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { data: [{ b64_json: B64 }] }));
    const friends = Array.from({ length: 20 }, (_, i) => friend(String(i)));
    await renderSelfie(options({ fetch, extraReferences: friends, clock: { hour: 9, minute: 0 } }));
    const sent = referencesSent(calls[0]?.payload ?? {});
    expect(sent).toHaveLength(16);
    expect(sent[0]).toBe(dataUrl("image/png", bytesOf("day")));
    expect(sent.at(-1)).toBe("https://friends/14.png");
  });

  test("publishes one URL per image into the store, logging the cost", async () => {
    const records = captureLogs();
    const store = new SelfieStore();
    const { fetch } = fakeFetch(() =>
      jsonResponse(200, {
        data: [{ b64_json: B64 }, { b64_json: B64, media_type: "image/webp" }],
        usage: { cost: 0.04 },
      }),
    );
    const result = await renderSelfie(options({ fetch, store }));
    if (!result.ok) throw new Error(result.error);
    expect(result.costUsd).toBe(0.04);
    expect(result.urls).toHaveLength(2);
    expect(result.urls[1]).toMatch(/\.webp$/);
    for (const url of result.urls)
      expect(store.lookup(url.split("/").at(-1) as string)).not.toBeNull();
    expect(logLines(records)).toEqual(["INFO [selfie] Generated 2 image(s), cost $0.0400"]);
  });

  test("leaves a zero or missing cost out of the log line", async () => {
    for (const usage of [{ cost: 0 }, undefined]) {
      const records = captureLogs();
      const { fetch } = fakeFetch(() => jsonResponse(200, { data: [{ b64_json: B64 }], usage }));
      await renderSelfie(options({ fetch }));
      expect(logLines(records)).toEqual(["INFO [selfie] Generated 1 image(s)"]);
    }
  });

  test("turns an ImageGenError into a failed render", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(402, { error: { message: "Insufficient credits", code: 402 } }),
    );
    expect(await renderSelfie(options({ fetch }))).toEqual({
      ok: false,
      error: "Selfie generation failed: 402: Insufficient credits",
    });
  });

  test("an outfit that vanished since startup is a failed render too", async () => {
    setEnv("SELFIE_REFERENCE_IMAGES", join(root, "gone.png"));
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { data: [{ b64_json: B64 }] }));
    expect(await renderSelfie(options({ fetch }))).toEqual({
      ok: false,
      error: `Selfie generation failed: ${join(root, "gone.png")}: no such file`,
    });
    expect(calls).toHaveLength(0);
  });

  test("lets anything else propagate", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expect(renderSelfie(options({ fetch }))).rejects.toBeInstanceOf(SyntaxError);
  });

  test("an abort rejects with the signal's reason", async () => {
    const { fetch, started } = hangingFetch();
    const controller = new AbortController();
    const pending = renderSelfie(options({ fetch, signal: controller.signal }));
    await started;
    const reason = new CancelledError("Task cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
