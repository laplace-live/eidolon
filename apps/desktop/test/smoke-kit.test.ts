// The desktop smokes' kit, without Electron: the app's environment, its drop list and a canary;
// the arguments; the server lock's .info and the token; the logs' error lines; the process table;
// the focus watch's parsing and verdict; and the fakes, over real loopback requests.
import "../../../packages/config/test/isolated-guard.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CREDENTIALS, SETTINGS } from "@eidolon/config";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PROVIDERS } from "../../../packages/providers/src/catalog.ts";
import {
  appEnv,
  DROPPED_NAMES,
  fakeAccounts,
  isDropped,
  OS_NAMES,
  osVariables,
} from "../scripts/smoke/env.ts";
import {
  CHAT_MESSAGE,
  type Fakes,
  FILES_REPLY,
  GREETING,
  REPLY,
  SELFIE_REPLY,
  SELFIE_REQUEST,
  SELFIE_SAID,
  startFakes,
  VOICE_TRANSCRIPT,
} from "../scripts/smoke/fakes.ts";
import { parseFront, parseType, unproven } from "../scripts/smoke/focus.ts";
import {
  errorLines,
  fakeMicrophoneArgs,
  localToken,
  parseSmokeArgs,
  runsFolder,
  serverAddress,
} from "../scripts/smoke/kit.ts";
import { descendants, Processes, parseTable } from "../scripts/smoke/processes.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const homes = {
  home: "/runs/a/home",
  realHome: "/runs/a/real-home",
  sharedSkills: "/runs/a/skills",
};
const fakes = { url: "http://127.0.0.1:9/v1", key: "fake-key" };

describe("the app's environment", () => {
  test("drops what local-smoke.ts drops: every credential, setting, provider base URL and field", () => {
    for (const name of CREDENTIALS) expect(DROPPED_NAMES.has(name), name).toBe(true);
    for (const row of SETTINGS) expect(DROPPED_NAMES.has(row.env), row.env).toBe(true);
    for (const provider of PROVIDERS) {
      if (provider.baseUrlEnv !== null) expect(DROPPED_NAMES.has(provider.baseUrlEnv)).toBe(true);
      for (const field of provider.fields ?? []) expect(DROPPED_NAMES.has(field.env)).toBe(true);
    }
    for (const name of [
      "OPENAI_API_KEY",
      "OLLAMA_BASE_URL",
      "MINIMAX_GROUP_ID",
      "MEM0_QDRANT_HOST",
    ]) {
      expect(DROPPED_NAMES.has(name), name).toBe(true);
    }
    expect(isDropped("EIDOLON_PERSONA")).toBe(true);
    expect(isDropped("eidolon_home")).toBe(true);
    expect(isDropped("ELECTRON_RUN_AS_NODE")).toBe(true);
    expect(isDropped("PATH")).toBe(false);
  });

  test("takes no OS name that is dropped", () => {
    for (const name of [...OS_NAMES.posix, ...OS_NAMES.win32]) {
      expect(isDropped(name), name).toBe(false);
    }
  });

  test("keeps a canary key, and every other variable of the smoke's own, from the app", () => {
    const canary = "eidolon-smoke-canary-0123";
    const from: NodeJS.ProcessEnv = {
      HOME: "/Users/owner",
      USER: "owner",
      TMPDIR: "/tmp/owner",
      PATH: "/usr/bin:/bin",
      LANG: "zh_CN.UTF-8",
      SHELL: "/bin/zsh",
      NODE_OPTIONS: `--require ${canary}`,
      ELECTRON_RUN_AS_NODE: "1",
      TTS_VOICE_ID_HAPPY: canary,
      EIDOLON_PERSONA: canary,
      EIDOLON_HOME: "/Users/owner/.laplace/eidolon",
      CI_SECRET: canary,
    };
    for (const name of DROPPED_NAMES) from[name] = canary;
    const env = appEnv({ homes, fakes, background: true, from, platform: "darwin" });
    expect(Object.values(env).filter((value) => value.includes(canary))).toEqual([]);
    expect(env).toEqual({
      HOME: "/Users/owner",
      USER: "owner",
      TMPDIR: "/tmp/owner",
      PATH: "/usr/bin:/bin",
      LANG: "zh_CN.UTF-8",
      ...fakeAccounts(fakes),
      EIDOLON_HOME: homes.home,
      EIDOLON_REAL_HOME: homes.realHome,
      EIDOLON_SHARED_SKILLS: homes.sharedSkills,
      EIDOLON_NO_DOTENV: "1",
      EIDOLON_DESKTOP_LOGIN_SHELL: "0",
      EIDOLON_DESKTOP_BACKGROUND: "1",
    });
  });

  test("puts every role it reaches on the fakes, hearing and voice on OpenAI's account", () => {
    expect(fakeAccounts(fakes)).toEqual({
      OPENROUTER_API_KEY: "fake-key",
      OPENROUTER_API_BASE: "http://127.0.0.1:9/v1",
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      STT_PROVIDER: "openai",
      TTS_PROVIDER: "openai",
      TTS_VOICE_ID: "marin",
    });
  });

  test("headful, background mode stays off", () => {
    const env = appEnv({ homes, fakes, background: false, from: {}, platform: "darwin" });
    expect(env.EIDOLON_DESKTOP_BACKGROUND).toBeUndefined();
    expect(env.EIDOLON_DESKTOP_LOGIN_SHELL).toBe("0");
  });

  test("on Windows finds the OS's names without case, under the spelling given, once", () => {
    const from: NodeJS.ProcessEnv = {
      Path: "C:\\Windows\\system32",
      PATH: "C:\\other",
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      comspec: "C:\\Windows\\system32\\cmd.exe",
      LOCALAPPDATA: "C:\\Users\\runneradmin\\AppData\\Local",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      OpenAI_Api_Key: "canary",
      RUNNER_TEMP: "D:\\a\\_temp",
    };
    expect(osVariables(from, "win32")).toEqual({
      Path: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      comspec: "C:\\Windows\\system32\\cmd.exe",
      LOCALAPPDATA: "C:\\Users\\runneradmin\\AppData\\Local",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
    // POSIX names have case: a lowercase home is someone else's variable.
    expect(osVariables({ home: "/x", HOME: "/Users/owner" }, "darwin")).toEqual({
      HOME: "/Users/owner",
    });
  });
});

describe("the smoke's arguments", () => {
  test("--headful anywhere; the rest are the smoke's own, in order", () => {
    expect(parseSmokeArgs([])).toEqual({ headful: false, rest: [] });
    expect(parseSmokeArgs(["--headful"])).toEqual({ headful: true, rest: [] });
    expect(parseSmokeArgs(["--app", "/x/Eidolon.exe", "--headful", "--keep"])).toEqual({
      headful: true,
      rest: ["--app", "/x/Eidolon.exe", "--keep"],
    });
    expect(parseSmokeArgs(["--headfull"])).toEqual({ headful: false, rest: ["--headfull"] });
  });

  test("runs go under RUNNER_TEMP on a runner, else the OS's temporary folder", () => {
    expect(runsFolder({ RUNNER_TEMP: "/runner/_temp" })).toBe("/runner/_temp");
    expect(runsFolder({ RUNNER_TEMP: "" })).toBe(tmpdir());
    expect(runsFolder({})).toBe(tmpdir());
  });

  test("the fake microphone is the fake device alone, a WAV with the audio service unsandboxed", () => {
    expect(fakeMicrophoneArgs()).toEqual(["--use-fake-device-for-media-stream"]);
    expect(fakeMicrophoneArgs("/run/speech.wav")).toEqual([
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-audio-capture=/run/speech.wav",
      "--disable-features=AudioServiceSandbox",
    ]);
  });
});

describe("the server lock's .info and local-token", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "eidolon-desktop-smoke-kit-"));
    mkdirSync(join(home, "locks"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const info = (value: unknown) =>
    writeFileSync(join(home, "locks", "4273f434b594.info"), JSON.stringify(value));

  test("names the server's pid, port and loopback host, IPv6 in brackets", () => {
    const base = { command: "eidolon", key: "local-server", start: 1 };
    info({ ...base, pid: 4242, port: 7860, host: "127.0.0.1" });
    expect(serverAddress(home)).toEqual({
      pid: 4242,
      port: 7860,
      host: "127.0.0.1",
      origin: "http://127.0.0.1:7860",
    });
    info({ ...base, pid: 4242, port: 51000, host: "[::1]" });
    expect(serverAddress(home)?.origin).toBe("http://[::1]:51000");
  });

  test("is null until the server records its port and host, and for a garbled file", () => {
    expect(serverAddress(home)).toBeNull();
    info({ pid: 4242, command: "eidolon", key: "local-server", start: 1 });
    expect(serverAddress(home)).toBeNull();
    info({ pid: 4242, port: 7860 });
    expect(serverAddress(home)).toBeNull();
    info({ pid: 4242, port: 7860, host: "192.168.1.2" });
    expect(serverAddress(home)).toBeNull();
    writeFileSync(join(home, "locks", "4273f434b594.info"), '{"pid": 42');
    expect(serverAddress(home)).toBeNull();
  });

  test("local-token is read as the server takes it", () => {
    expect(localToken(home)).toBeNull();
    writeFileSync(join(home, "local-token"), `${"t".repeat(43)}\n`);
    expect(localToken(home)).toBe("t".repeat(43));
    writeFileSync(join(home, "local-token"), "short\n");
    expect(localToken(home)).toBeNull();
  });
});

test("the logs' error lines: main's at electron-log's error level, the backend's at ERROR", () => {
  const main = [
    "[2026-11-21 10:29:58.601] [info]  Eidolon 0.0.0-dev · Electron 45.4.1",
    "[2026-11-21 10:29:59.000] [warn]  Eidolon: couldn't check what quitting stops: timeout",
    "[2026-11-21 10:30:00.000] [error] Eidolon: a renderer is gone (crashed, exit code 11)",
  ].join("\n");
  const backend = [
    "[2026-11-21 10:29:59.525] 2026-11-21T18:29:59.503Z | WARNING  | Persona facts: no table",
    "[2026-11-21 10:29:59.526] 2026-11-21T18:29:59.503Z | ERROR    | boom",
    "[2026-11-21 10:29:59.527] 2026-11-21T18:29:59.503Z | CRITICAL | worse",
    "[2026-11-21 10:29:59.528] 2026-11-21T18:29:59.503Z | INFO     | ERROR in a message",
  ].join("\n");
  expect(errorLines(main, "main")).toEqual([main.split("\n")[2]]);
  expect(errorLines(backend, "backend")).toEqual(backend.split("\n").slice(1, 3));
});

describe("the process table", () => {
  test("reads ps's lines and PowerShell's, skipping any without two numbers first", () => {
    const ps =
      "  PID  PPID COMMAND\n  101     1 /sbin/launchd\n 4242   101 /Applications/Eidolon.app/Contents/MacOS/Eidolon --user-data-dir=/t/p\n";
    expect(parseTable(ps, "darwin")).toEqual([
      { pid: 101, ppid: 1, command: "/sbin/launchd" },
      {
        pid: 4242,
        ppid: 101,
        command: "/Applications/Eidolon.app/Contents/MacOS/Eidolon --user-data-dir=/t/p",
      },
    ]);
    const windows =
      '4\t0\tSystem\r\n5120\t880\t"C:\\Program Files\\Eidolon\\Eidolon.exe" --quit\r\n\r\n';
    expect(parseTable(windows, "win32")).toEqual([
      { pid: 4, ppid: 0, command: "System" },
      { pid: 5120, ppid: 880, command: '"C:\\Program Files\\Eidolon\\Eidolon.exe" --quit' },
    ]);
  });

  test("finds what runs under the roots, at any depth, roots left out", () => {
    const table = [
      { pid: 1, ppid: 0, command: "launchd" },
      { pid: 10, ppid: 1, command: "main" },
      { pid: 11, ppid: 10, command: "backend" },
      { pid: 12, ppid: 11, command: "job" },
      { pid: 20, ppid: 1, command: "other" },
    ];
    expect(descendants(table, [10]).map((row) => row.pid)).toEqual([11, 12]);
    expect(descendants(table, [20])).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "stops a tracked process and what it started, and then nothing runs",
    async () => {
      const processes = new Processes();
      // A parent that starts a child of its own, which outlives it unless killed by pid.
      const script = `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(child.pid);
setInterval(() => {}, 1000);`;
      const parent = processes.spawn("parent", process.execPath, ["-e", script], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const childPid = await new Promise<number>((done) => {
        parent.child.stdout?.once("data", (data: Buffer) => done(Number(String(data).trim())));
      });
      await processes.snapshot();
      expect(await processes.ours(childPid)).toBe(true);
      expect((await processes.running()).length).toBe(2);
      await processes.stopAll();
      expect(await processes.settle(5000)).toEqual([]);
      await parent.exited;
    },
  );
});

test("the focus watch reads lsappinfo's front app and an application's type", () => {
  const front = `"Google Chrome" ASN:0x0-0x5859854: (in front) \n    bundleID=[ NULL ] \n    pid = 92667 !cgsConnection !signalled type=[ NULL ]  flavor=[ NULL ]\n`;
  expect(parseFront(front)).toEqual({ name: "Google Chrome", pid: 92667 });
  expect(parseFront("[ NULL ]  [ NULL ]  \n")).toEqual({ name: "(none)", pid: null });
  const type = ` !cgsConnection !signalled type="UIElement" flavor=[ NULL ]  Version=[ NULL ]`;
  expect(parseType(type)).toBe("UIElement");
  expect(parseType("type=[ NULL ]")).toBeNull();
});

test("the focus watch fails what it can't vouch for: no sample, or a main never an accessory", () => {
  const main = { pid: 4242, since: 0, accessory: false, reported: false, last: null };
  expect(unproven(120, [{ ...main, accessory: true, last: "UIElement" }])).toEqual([]);
  expect(unproven(0, [])).toEqual(["lsappinfo named no front app in any sample"]);
  expect(unproven(120, [main])).toEqual([
    "the app's main (pid 4242) was never seen as an accessory (UIElement): LaunchServices never knew it",
  ]);
  // A regular app for less than the time it has to become an accessory.
  expect(unproven(120, [{ ...main, last: "Foreground" }])).toEqual([
    "the app's main (pid 4242) was never seen as an accessory (UIElement), only as Foreground",
  ]);
  expect(unproven(120, [{ ...main, reported: true, last: "Foreground" }])).toEqual([]);
});

describe("the fakes", () => {
  let served: Fakes;
  beforeEach(async () => {
    served = await startFakes({ replyHoldMs: 300 });
  });
  afterEach(() => served.stop());

  const post = (path: string, body: unknown, key = served.key) =>
    fetch(`${served.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /** The streamed reply's text deltas, and when each arrived. */
  async function deltas(response: Response): Promise<{ text: string; at: number }[]> {
    const out: { text: string; at: number }[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const event = buffer.slice(0, end).replace(/^data: /, "");
        buffer = buffer.slice(end + 2);
        if (event === "[DONE]") continue;
        const delta = JSON.parse(event).choices?.[0]?.delta;
        if (typeof delta?.content === "string") out.push({ text: delta.content, at: Date.now() });
        if (delta?.tool_calls)
          out.push({ text: `call:${delta.tool_calls[0].function.name}`, at: Date.now() });
      }
    }
    return out;
  }

  test("answer their key only, count by route, and record what they don't serve", async () => {
    expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect((await post("/embeddings", { input: "x" }, "wrong")).status).toBe(401);
    expect((await fetch(`${served.url}/rerank`, { method: "POST" })).status).toBe(404);
    const models = await fetch(`${served.url}/models`, {
      headers: { authorization: `Bearer ${served.key}` },
    });
    expect((await models.json()).data.map((model: { id: string }) => model.id)).toContain(
      "fake-chat",
    );
    const images = await fetch(`${served.url}/models?output_modalities=image`, {
      headers: { authorization: `Bearer ${served.key}` },
    });
    expect((await images.json()).data).toEqual([
      { id: "fake-image", object: "model", owned_by: "desktop-smoke" },
    ]);
    expect(served.refused).toEqual(["POST /v1/embeddings"]);
    expect(served.unknown).toEqual(["POST /v1/rerank"]);
    expect(served.counts()).toEqual({ "GET /v1/models": 2 });
    expect([...served.authorizations]).toEqual(["Bearer wrong", `Bearer ${served.key}`]);
  });

  test("stream her reply in its parts, replyHoldMs apart; greet anything else", async () => {
    const asked = {
      model: "fake-chat",
      stream: true,
      messages: [{ role: "user", content: CHAT_MESSAGE }],
    };
    const parts = await deltas(await post("/chat/completions", asked));
    expect(parts.map((part) => part.text)).toEqual([...REPLY]);
    expect(parts[1].at - parts[0].at).toBeGreaterThanOrEqual(250);
    const other = { stream: true, messages: [{ role: "user", content: "随便聊聊" }] };
    expect((await deltas(await post("/chat/completions", other))).map((p) => p.text)).toEqual([
      GREETING,
    ]);
    const files = {
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "看看" }] }],
    };
    expect((await deltas(await post("/chat/completions", files))).map((p) => p.text)).toEqual([
      FILES_REPLY,
    ]);
    const plain = await post("/chat/completions", {
      messages: [{ role: "user", content: CHAT_MESSAGE }],
    });
    expect((await plain.json()).choices[0].message.content).toBe(REPLY.join(""));
    expect(served.streams.map((stream) => stream.cancelled)).toEqual([false, false, false]);
    expect(served.count("POST /v1/chat/completions")).toBe(4);
  });

  test("call take_selfie when asked for a selfie and offered it, then answer its result", async () => {
    const tools = [{ type: "function", function: { name: "take_selfie" } }];
    const asked = { stream: true, tools, messages: [{ role: "user", content: SELFIE_REQUEST }] };
    expect((await deltas(await post("/chat/completions", asked))).map((p) => p.text)).toEqual([
      SELFIE_SAID,
      "call:take_selfie",
    ]);
    const unoffered = { stream: true, messages: [{ role: "user", content: SELFIE_REQUEST }] };
    expect((await deltas(await post("/chat/completions", unoffered))).map((p) => p.text)).toEqual([
      GREETING,
    ]);
    const result = { stream: true, messages: [{ role: "tool", content: '{"status":"finished"}' }] };
    expect((await deltas(await post("/chat/completions", result))).map((p) => p.text)).toEqual([
      SELFIE_REPLY,
    ]);
    const drawn = await (await post("/images", { model: "fake-image", prompt: "selfie" })).json();
    const image = Buffer.from(drawn.data[0].b64_json, "base64");
    expect(image.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(image.readUInt32BE(16)).toBe(64);
    expect(drawn.data[0].media_type).toBe("image/png");
  });

  test("hold a reply after its first part, and record a turn stopped there", async () => {
    const release = served.holdReplies();
    const response = await post("/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: CHAT_MESSAGE }],
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(REPLY[0]);
    await new Promise((done) => setTimeout(done, 400));
    expect(served.streams[0]).toMatchObject({ endedAt: null, cancelled: false });
    await reader.cancel();
    await new Promise((done) => setTimeout(done, 100));
    expect(served.streams[0].cancelled).toBe(true);
    release();
  });

  test("hold embeddings until released, then embed each input", async () => {
    const release = served.holdEmbeddings();
    let answered = false;
    const pending = post("/embeddings", { input: ["一", "二"], dimensions: 8 }).then((response) => {
      answered = true;
      return response.json();
    });
    await new Promise((done) => setTimeout(done, 300));
    expect(answered).toBe(false);
    release();
    const { data } = await pending;
    expect(data.map((row: { embedding: number[] }) => row.embedding.length)).toEqual([8, 8]);
    expect(Math.hypot(...data[0].embedding)).toBeCloseTo(1);
  });

  test("decide no to every question, and speak, hear and transcribe", async () => {
    const decided = await (
      await fetch(served.url.replace(/\/v1$/, "/alpha/decisions"), {
        method: "POST",
        headers: { authorization: `Bearer ${served.key}` },
        body: JSON.stringify({ questions: { about_her: "?", invites_reply: "?" } }),
      })
    ).json();
    expect(decided.answers).toEqual({
      about_her: { type: "noul", noul: 0 },
      invites_reply: { type: "noul", noul: 0 },
    });
    const pcm = await post("/audio/speech", { input: "你好", response_format: "pcm" });
    expect(pcm.headers.get("content-type")).toBe("audio/pcm");
    expect((await pcm.arrayBuffer()).byteLength).toBe(48_000);
    const mp3 = await post("/audio/speech", { input: "你好", response_format: "mp3" });
    expect(new Uint8Array(await mp3.arrayBuffer()).subarray(0, 2)).toEqual(
      new Uint8Array([0xff, 0xfb]),
    );
    const form = new FormData();
    form.set("model", "gpt-4o-transcribe");
    form.set("file", new Blob([new Uint8Array(1000)]), "voice.webm");
    const heard = await fetch(`${served.url}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${served.key}` },
      body: form,
    });
    expect((await heard.json()).text).toBe(VOICE_TRANSCRIPT);
  });

  test("hold a call's realtime transcription session, as OpenAI's answers the backend's client", async () => {
    // The ws package the backend's OpenAI hearing connects with.
    const WebSocket = createRequire(join(ROOT, "packages/providers/package.json"))("ws") as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => {
      on(event: "message", listener: (data: Buffer) => void): void;
      on(event: "open" | "close", listener: () => void): void;
      on(event: "pong", listener: (data: Buffer) => void): void;
      on(
        event: "unexpected-response",
        listener: (request: unknown, response: { statusCode: number }) => void,
      ): void;
      on(event: "error", listener: () => void): void;
      send(data: string): void;
      ping(data: string): void;
      close(): void;
    };
    const url = `${served.url.replace(/^http/, "ws")}/realtime?intent=transcription`;
    const refused = new WebSocket(url, { headers: { Authorization: "Bearer wrong" } });
    const status = await new Promise<number>((done) => {
      refused.on("unexpected-response", (_request, response) => done(response.statusCode));
      refused.on("error", () => {});
    });
    expect(status).toBe(401);

    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${served.key}` } });
    const events: Record<string, unknown>[] = [];
    socket.on("message", (data) => events.push(JSON.parse(String(data))));
    const until = async (count: number) => {
      for (let i = 0; i < 100 && events.length < count; i++) {
        await new Promise((done) => setTimeout(done, 20));
      }
    };
    await new Promise<void>((done) => socket.on("open", () => done()));
    await until(1);
    socket.send(JSON.stringify({ type: "session.update", session: { type: "transcription" } }));
    await until(2);
    const audio = Buffer.alloc(70_000).toString("base64");
    for (let i = 0; i < 3; i++)
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await until(3);
    expect(served.say("再说一遍")).toBe(1);
    await until(4);
    const pong = new Promise<string>((done) => socket.on("pong", (data) => done(String(data))));
    socket.ping("alive");
    expect(await pong).toBe("alive");
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "session.updated",
      "conversation.item.input_audio_transcription.completed",
      "conversation.item.input_audio_transcription.completed",
    ]);
    expect(events.slice(2).map((event) => event.transcript)).toEqual([
      VOICE_TRANSCRIPT,
      "再说一遍",
    ]);
    expect(served.realtime).toEqual([
      { appended: 3, commits: 1, heard: [VOICE_TRANSCRIPT, "再说一遍"], closed: false },
    ]);
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    socket.close();
    await closed;
    expect(served.count("GET /v1/realtime")).toBe(1);
    expect(served.refused).toEqual(["GET /v1/realtime"]);
  });
});
