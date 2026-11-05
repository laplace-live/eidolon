// failureOf against what each client really throws: Soniox's, refine's OpenAIClient and the
// embedding client, each over a fake fetch.
import { expect, test } from "bun:test";
import { OpenAIClient } from "@eidolon/config";
import { EmbeddingClient } from "@eidolon/retrieval";
import { download, failureOf, LockedError, sharedFailure, transcribe } from "../src/index.ts";
import { captureLogs } from "./pipeline_helpers.ts";

function answering(status: number, body: unknown): typeof fetch {
  return (async () => Response.json(body, { status })) as unknown as typeof fetch;
}

const unreachable = (async () => {
  throw new TypeError("Unable to connect. Is the computer able to access the url?");
}) as unknown as typeof fetch;

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const STATUSES: [number, string][] = [
  [401, "auth-failed"],
  [402, "insufficient-credits"],
  [429, "rate-limited"],
];

test("Soniox: 401, 402 and 429 after retries, and no connection", async () => {
  for (const [status, code] of STATUSES) {
    const client = new transcribe.SonioxClient({
      apiKey: "k",
      fetch: answering(status, { message: "no", error_type: "x" }),
      retryDelaysMs: [],
    });
    const error = await thrown(() => client.getTranscription("t"));
    expect(failureOf(error, "soniox")).toEqual({ code, provider: "soniox" } as never);
  }
  const offline = new transcribe.SonioxClient({
    apiKey: "k",
    fetch: unreachable,
    retryDelaysMs: [],
  });
  expect(failureOf(await thrown(() => offline.getTranscription("t")), "soniox")).toEqual({
    code: "network",
    provider: "soniox",
  });
  const invalid = new transcribe.SonioxClient({
    apiKey: "k",
    fetch: answering(400, { message: "bad audio" }),
  });
  expect(failureOf(await thrown(() => invalid.getTranscription("t")), "soniox")).toBeNull();
});

test("refine's OpenAIClient: 401, 402 and 429, with a JSON body or not, and no connection", async () => {
  for (const [status, code] of STATUSES) {
    for (const fake of [
      answering(status, { error: { message: "no", code: status } }),
      (async () => new Response("<html>nope</html>", { status })) as unknown as typeof fetch,
    ]) {
      const client = new OpenAIClient(
        { baseUrl: "https://x.invalid/v1", apiKey: "k" },
        { fetch: fake, maxRetries: 0 },
      );
      const error = await thrown(() => client.post("chat/completions", {}));
      // A 402 that isn't JSON says nothing of its status; every other case does.
      const expected = status === 402 && !String(error).includes("Error code") ? null : { code };
      expect(failureOf(error, "refine"), `${status}`).toEqual(
        expected === null ? null : ({ ...expected, provider: "refine" } as never),
      );
    }
  }
  const offline = new OpenAIClient(
    { baseUrl: "https://x.invalid/v1", apiKey: "k" },
    {
      fetch: unreachable,
      maxRetries: 0,
    },
  );
  expect(failureOf(await thrown(() => offline.post("chat/completions", {})), "refine")).toEqual({
    code: "network",
    provider: "refine",
  });
});

test("the embedding client: 401, 402 and 429, no connection, and a quota error every time", async () => {
  const options = { model: "m", dimensions: 2 };
  for (const [status, code] of STATUSES) {
    const client = new EmbeddingClient({
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
      fetch: answering(status, { error: { message: "no" } }),
      maxRetries: 0,
    });
    const error = await thrown(() => client.embedWithUsage(["a"], options));
    expect(failureOf(error, "embeddings")).toEqual({ code, provider: "embeddings" } as never);
  }
  const offline = new EmbeddingClient({
    baseUrl: "https://x.invalid/v1",
    apiKey: "k",
    fetch: unreachable,
    maxRetries: 0,
  });
  expect(
    failureOf(await thrown(() => offline.embedWithUsage(["a"], options)), "embeddings"),
  ).toEqual({ code: "network", provider: "embeddings" });
  // OpenRouter wraps an upstream 429 in a 200 body.
  const quota = new EmbeddingClient({
    baseUrl: "https://x.invalid/v1",
    apiKey: "k",
    fetch: answering(200, { error: { message: "RESOURCE_EXHAUSTED: quota exceeded", code: 429 } }),
    sleep: async () => {},
    maxRetries: 0,
  });
  const logs = captureLogs();
  try {
    expect(
      failureOf(await thrown(() => quota.embedWithUsage(["a"], options)), "embeddings"),
    ).toEqual({ code: "rate-limited", provider: "embeddings" });
  } finally {
    logs.stop();
  }
});

test("a full disk, from Node, SQLite or a message, whatever the provider", () => {
  const node = Object.assign(new Error("ENOSPC: no space left on device, write"), {
    code: "ENOSPC",
    errno: -28,
    syscall: "write",
  });
  const sqlite = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
  const lance = new Error("LanceError(IO): No space left on device (os error 28)");
  for (const error of [node, sqlite, lance]) {
    expect(failureOf(error)).toEqual({ code: "disk-full" });
    expect(failureOf(error, "embeddings")).toEqual({ code: "disk-full" });
  }
});

test("an error that carries an event code keeps it; others have none", () => {
  expect(failureOf(new LockedError("laplace-refine", "milky-green", 1))).toEqual({
    code: "locked",
  });
  expect(failureOf(new download.YtDlpUnavailableError("no yt-dlp"))).toEqual({
    code: "ytdlp-unavailable",
  });
  expect(failureOf(transcribe.ffmpegMissing())).toEqual({ code: "ffmpeg-unavailable" });
  const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  expect(failureOf(enoent, "soniox")).toBeNull();
  expect(failureOf(new Error("Error code: 401 - {}"))).toBeNull();
  expect(failureOf("not an error", "refine")).toBeNull();
});

test("sharedFailure: the code every failure has, or none", () => {
  const auth = { code: "auth-failed", provider: "refine" } as const;
  expect(sharedFailure([auth, { ...auth }])).toEqual(auth);
  expect(sharedFailure([auth, null])).toBeNull();
  expect(sharedFailure([auth, { code: "auth-failed", provider: "embeddings" }])).toBeNull();
  expect(sharedFailure([])).toBeNull();
});
