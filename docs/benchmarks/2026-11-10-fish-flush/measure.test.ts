import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { costOf, priceOf } from "../../../packages/providers/src/index.ts";
import { packMsg, unpackMsg } from "../../../packages/providers/src/speech/stream/msgpack.ts";
import {
  type Arrival,
  type FlushRecord,
  type PipelinedSummary,
  playout,
  type SerialRecord,
  type SerialSummary,
  stats,
  suggest,
  summarizePipelined,
  summarizeSerial,
  wavFile,
} from "./analyze.ts";

// 100 ms of 44.1 kHz 16-bit mono.
const TENTH = 8820;

describe("the arithmetic", () => {
  test("percentiles are nearest-rank", () => {
    expect(stats([])).toBeNull();
    expect(stats([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, p90: 5, p99: 5, max: 5 });
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(stats(hundred)).toEqual({ n: 100, p50: 50, p90: 90, p99: 99, max: 100 });
  });

  test("the suggestion rounds the largest gap up to 10 ms and adds the larger of 100 ms and half", () => {
    expect(suggest(61.2)).toEqual({
      largestGapMs: 61.2,
      roundedMs: 70,
      marginMs: 100,
      idleMs: 170,
    });
    expect(suggest(250.01)).toEqual({
      largestGapMs: 250.01,
      roundedMs: 260,
      marginMs: 130,
      idleMs: 390,
    });
    expect(suggest(400).idleMs).toBe(600);
    expect(suggest(0).idleMs).toBe(100);
  });

  test("playback stalls only where audio comes later than the audio before it runs out", () => {
    expect(
      playout([
        { t: 0, bytes: TENTH },
        { t: 150, bytes: TENTH },
        { t: 160, bytes: TENTH },
      ]),
    ).toEqual([0, 50, 0]);
  });

  const flushA: FlushRecord = {
    text: "a",
    listen: "",
    sentAt: 0,
    arrivals: [
      { t: 400, bytes: TENTH },
      { t: 410, bytes: TENTH },
      { t: 470, bytes: TENTH },
    ],
    movedOnAt: 2970,
  };
  const flushB: FlushRecord = {
    text: "b",
    listen: "",
    sentAt: 2970,
    arrivals: [
      { t: 3270, bytes: 2 * TENTH },
      { t: 3300, bytes: TENTH },
    ],
    movedOnAt: 5800,
  };
  const clean: SerialRecord = {
    settleMs: 2500,
    flushes: [flushA, flushB],
    stopAt: 5800,
    afterStop: [],
    finishAt: 5900,
    error: null,
  };

  test("a serial run: each flush's timing, the spreads, the suggestion and its projection", () => {
    const summary = summarizeSerial(clean);
    expect(summary.flushes).toEqual([
      {
        flush: 1,
        messages: 3,
        firstMs: 400,
        burstMs: 70,
        maxGapMs: 60,
        audioSeconds: 0.3,
        slackMs: 230,
        waitMs: 2500,
        wavSeconds: 0,
      },
      {
        flush: 2,
        messages: 2,
        firstMs: 300,
        burstMs: 30,
        maxGapMs: 30,
        audioSeconds: 0.3,
        slackMs: 270,
        waitMs: 2500,
        wavSeconds: 0.3,
      },
    ]);
    expect(summary.gaps).toEqual({ n: 3, p50: 30, p90: 60, p99: 60, max: 60 });
    expect(summary.first).toEqual({ n: 2, p50: 300, p90: 400, p99: 400, max: 400 });
    expect(summary.suggestion?.idleMs).toBe(160);
    // Replayed: A's audio plays 400–700; B goes at 470 + 160 = 630 and answers 300 ms later, at
    // 930, so 230 ms of silence falls before it.
    expect(summary.projection).toEqual({
      idleMs: 160,
      boundaryMs: [230],
      boundary: { n: 1, p50: 230, p90: 230, p99: 230, max: 230 },
      insideMs: 0,
    });
    expect(summary.afterStop).toEqual({ messages: 0, bytes: 0 });
    expect(summary.finishAfterStopMs).toBe(100);
    expect(summary).toMatchObject({ clean: true, reasons: [] });
  });

  test("each way a run can show no clean separation is named", () => {
    const summary = summarizeSerial({
      ...clean,
      settleMs: 150,
      flushes: [flushA, { ...flushB, arrivals: [] }],
      afterStop: [{ t: 5850, bytes: 100 }],
      error: "Fish Audio server error during synthesis",
    });
    expect(summary.clean).toBe(false);
    expect(summary.reasons).toEqual([
      "the session failed: Fish Audio server error during synthesis",
      "flush 2 brought no audio",
      "1 audio messages came after the last flush had been quiet 150 ms",
      "the suggested threshold, 160 ms, is not under the 150 ms this run waited, so a pause inside a burst can't be told from its end",
    ]);
    expect(summary.projection?.boundaryMs).toEqual([]);
  });

  test("a pipelined run: its gaps, where the largest fell in its audio, and its stalls", () => {
    const arrivals: Arrival[] = [
      { t: 300, bytes: TENTH },
      { t: 310, bytes: TENTH },
      { t: 600, bytes: TENTH },
      { t: 605, bytes: TENTH },
    ];
    expect(
      summarizePipelined({ texts: [], sentAt: 0, arrivals, finishAt: 700, error: null }),
    ).toEqual({
      messages: 4,
      firstMs: 300,
      burstMs: 305,
      gaps: { n: 3, p50: 10, p90: 290, p99: 290, max: 290 },
      largestGaps: [
        { ms: 290, atSeconds: 0.2 },
        { ms: 10, atSeconds: 0.1 },
        { ms: 5, atSeconds: 0.3 },
      ],
      audioSeconds: 0.4,
      stallMs: 100,
    });
  });

  test("the WAV is 44.1 kHz mono 16-bit, its chunks in order", () => {
    const wav = wavFile([Int16Array.from([1, -2]), Int16Array.from([300])]);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([
      1, 44_100, 16,
    ]);
    expect(view.getUint32(40, true)).toBe(6);
    expect([0, 1, 2].map((i) => view.getInt16(44 + i * 2, true))).toEqual([1, -2, 300]);
  });
});

const SCRIPT = join(import.meta.dir, "measure.ts");
const ROOT = join(import.meta.dir, "../../..");
const KEY = "sk-fake-fish-0123456789";
const SETTLE_MS = 300;
// The fake answers its nth flush on a session after FIRST_MS, in 2 + n % 3 messages a tenth of a
// second long, with GAP_MS[i % 2] before the ith.
const FIRST_MS = 20;
const GAP_MS = [12, 4];
const chunksOf = (n: number) => 2 + (n % 3);

interface Peer {
  readonly path: string;
  readonly headers: Headers;
  readonly received: { readonly t: number; readonly message: Record<string, unknown> }[];
  /** When each flush's last audio went, by flush. */
  readonly lastAudio: number[];
  flushes: number;
  chain: Promise<void>;
}

/** Fish's live socket as the script drives it: a flush's audio comes in order after the last's. */
function fakeFish() {
  const peers: Peer[] = [];
  const server = Bun.serve<{ peer: Peer }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      const peer: Peer = {
        path: url.pathname,
        headers: request.headers,
        received: [],
        lastAudio: [],
        flushes: 0,
        chain: Promise.resolve(),
      };
      if (srv.upgrade(request, { data: { peer } })) return undefined;
      return new Response("no upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        peers.push(ws.data.peer);
      },
      message(ws: ServerWebSocket<{ peer: Peer }>, data) {
        const { peer } = ws.data;
        const message = unpackMsg(data as Uint8Array) as Record<string, unknown>;
        peer.received.push({ t: performance.now(), message });
        if (message.event === "flush") {
          const n = peer.flushes++;
          peer.chain = peer.chain.then(async () => {
            await Bun.sleep(FIRST_MS);
            for (let i = 0; i < chunksOf(n); i++) {
              if (i > 0) await Bun.sleep(GAP_MS[i % 2] as number);
              ws.send(packMsg({ event: "audio", audio: new Uint8Array(TENTH) }));
            }
            peer.lastAudio[n] = performance.now();
          });
        } else if (message.event === "stop") {
          peer.chain = peer.chain.then(() => {
            ws.send(packMsg({ event: "finish", reason: "stop" }));
          });
        }
      },
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, peers, stop: () => server.stop(true) };
}

describe("the script against a fake Fish", () => {
  let home: string;
  let fake: ReturnType<typeof fakeFish>;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "fish-flush-"));
    fake = fakeFish();
    writeFileSync(
      join(home, "credentials.json"),
      JSON.stringify({
        accounts: { "fake-fish": { provider: "fish", apiKey: KEY, baseUrl: fake.base } },
      }),
      { mode: 0o600 },
    );
  });

  afterAll(() => {
    fake.stop();
    rmSync(home, { recursive: true, force: true });
  });

  /** The script on a data home whose voice role is the fake's account, and no .env. */
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: tmpdir(),
        HOME: home,
        EIDOLON_NO_DOTENV: "1",
        EIDOLON_HOME: home,
        EIDOLON_USAGE_DB: join(home, "usage.db"),
        TTS_PROVIDER: "fake-fish",
        TTS_VOICE_ID: "voice-fake",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }

  test("--dry-run prints the plan and its cost, under the cap, and connects to nothing", async () => {
    const { stdout, code } = await run("--dry-run");
    expect(code).toBe(0);
    expect(stdout).toContain(`endpoint ws://127.0.0.1:${new URL(fake.base).port}/v1/tts/live`);
    const [, characters, bytes] = /(\d+) characters, (\d+) bytes/.exec(stdout) ?? [];
    expect(Number(characters)).toBeGreaterThan(0);
    expect(Number(characters)).toBeLessThanOrEqual(600);
    const price = priceOf("fish", "tts", "drama-3");
    const cost = price && costOf(price, { bytes: Number(bytes) });
    expect(stdout).toContain(`about $${cost?.toFixed(4)}`);
    expect(fake.peers).toEqual([]);
  });

  test("a full run: serial flushes paced by the settle, a pipelined run, the files and the ledger", async () => {
    const out = join(home, "results.json");
    const wav = join(home, "serial.wav");
    const args = ["--out", out, "--wav", wav, "--settle-ms", String(SETTLE_MS), "--warm-ms", "50"];
    const { stdout, stderr, code } = await run(...args);
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
    const results = JSON.parse(readFileSync(out, "utf8"));
    const texts: string[] = results.sentences.map((line: { text: string }) => line.text);
    const pipelinedTexts: string[] = texts.slice(0, results.pipelinedSentences);

    const [serialPeer, pipelinedPeer] = fake.peers as [Peer, Peer];
    expect(serialPeer.path).toBe("/v1/tts/live");
    expect(serialPeer.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(serialPeer.headers.get("model")).toBe("drama-3");
    expect(serialPeer.received[0]?.message).toEqual({
      event: "start",
      request: {
        text: "",
        sample_rate: 44_100,
        latency: "normal",
        format: "pcm",
        normalize: false,
        prosody: { speed: 1, volume: 0 },
        reference_id: "voice-fake",
      },
    });
    const events = (peer: Peer) => peer.received.slice(1).map(({ message }) => message.event);
    expect(events(serialPeer)).toEqual([...texts.flatMap(() => ["text", "flush"]), "stop"]);
    expect(events(pipelinedPeer)).toEqual([
      ...pipelinedTexts.flatMap(() => ["text", "flush"]),
      "stop",
    ]);
    const sent = serialPeer.received.filter(({ message }) => message.event === "text");
    expect(sent.map(({ message }) => message.text)).toEqual(texts);
    // Each flush after the first went only once the last one's audio had been quiet the settle.
    for (let n = 1; n < sent.length; n++) {
      const quiet = (sent[n]?.t as number) - (serialPeer.lastAudio[n - 1] as number);
      expect(quiet).toBeGreaterThanOrEqual(SETTLE_MS - 2);
    }

    const serial: SerialSummary = results.summary.serial;
    expect(serial.flushes.map((flush) => flush.messages)).toEqual(texts.map((_, n) => chunksOf(n)));
    expect(serial.flushes.map((flush) => flush.audioSeconds)).toEqual(
      texts.map((_, n) => chunksOf(n) / 10),
    );
    for (const flush of serial.flushes) {
      expect(flush.firstMs).toBeGreaterThanOrEqual(FIRST_MS - 1);
      expect(flush.waitMs).toBeGreaterThanOrEqual(SETTLE_MS);
    }
    const largest = serial.gaps?.max as number;
    expect(largest).toBeGreaterThanOrEqual(Math.max(...GAP_MS) - 2);
    expect(largest).toBeLessThan(150);
    expect(serial.suggestion).toEqual(suggest(largest));
    expect(serial.afterStop).toEqual({ messages: 0, bytes: 0 });
    expect(serial.finishAfterStopMs).not.toBeNull();
    expect(serial).toMatchObject({ clean: true, reasons: [] });
    expect(stdout).toContain(`suggested FISH_SEGMENT_IDLE_MS = ${serial.suggestion?.idleMs}`);
    expect(stdout).toContain("verdict: clean separation");

    const pipelined: PipelinedSummary = results.summary.pipelined;
    const pipelinedChunks = pipelinedTexts.reduce((n, _, i) => n + chunksOf(i), 0);
    expect(pipelined.messages).toBe(pipelinedChunks);
    expect(pipelined.audioSeconds).toBeCloseTo(pipelinedChunks / 10, 6);

    const serialChunks = texts.reduce((n, _, i) => n + chunksOf(i), 0);
    expect(readFileSync(wav).length).toBe(44 + serialChunks * TENTH);
    expect(readFileSync(join(home, "serial-pipelined.wav")).length).toBe(
      44 + pipelinedChunks * TENTH,
    );

    const said = [...texts, ...pipelinedTexts];
    const db = new Database(join(home, "usage.db"), { readonly: true });
    const rows = db
      .query("SELECT role, provider, model, characters, bytes, source, cost_source FROM usage")
      .all();
    db.close();
    expect(rows).toEqual([
      {
        role: "voice",
        provider: "fish",
        model: "drama-3",
        characters: said.reduce((n, text) => n + [...text].length, 0),
        bytes: said.reduce((n, text) => n + Buffer.byteLength(text), 0),
        source: "job",
        cost_source: "estimated",
      },
    ]);
  }, 30_000);
});
