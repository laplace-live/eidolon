// The dev smoke's parts that need no Electron: the fake microphone's WAV, its steps' lines, records
// and results, and the window watch's reading of osascript's lines.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { framed, RATE, wavFile, wavSamples } from "../scripts/dev-smoke/speech.ts";
import { described, Steps, stepLine, writeResults } from "../scripts/dev-smoke/steps.ts";
import { parseLook, watchWindows } from "../scripts/dev-smoke/windows.ts";
import { Checks } from "../scripts/smoke/kit.ts";

/** A RIFF chunk, padded to an even size as the format has it. */
function chunk(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}

function format(channels: number, rate: number, bits: number): Buffer {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(1, 0);
  data.writeUInt16LE(channels, 2);
  data.writeUInt32LE(rate, 4);
  data.writeUInt32LE((rate * channels * bits) / 8, 8);
  data.writeUInt16LE((channels * bits) / 8, 12);
  data.writeUInt16LE(bits, 14);
  return chunk("fmt ", data);
}

function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("the fake microphone's WAV", () => {
  test("reads back the samples it writes", () => {
    const samples = Int16Array.from([0, 1200, -1200, 32767, -32768]);
    expect([...wavSamples(wavFile(samples))]).toEqual([...samples]);
  });

  test("skips the chunks afconvert writes before the data, odd sizes padded", () => {
    const samples = Buffer.alloc(8);
    samples.writeInt16LE(-7, 0);
    samples.writeInt16LE(7, 6);
    const file = riff(
      format(1, RATE, 16),
      chunk("FLLR", Buffer.alloc(13)),
      chunk("LIST", Buffer.alloc(3)),
      chunk("data", samples),
    );
    expect([...wavSamples(file)]).toEqual([-7, 0, 0, 7]);
  });

  test("refuses any other format, and a file that isn't a WAV", () => {
    const data = chunk("data", Buffer.alloc(4));
    expect(() => wavSamples(riff(format(2, RATE, 16), data))).toThrow(/mono/);
    expect(() => wavSamples(riff(format(1, 44_100, 16), data))).toThrow(/48000 Hz/);
    expect(() => wavSamples(riff(format(1, RATE, 16)))).toThrow(/no data/);
    expect(() => wavSamples(Buffer.from("not a wav at all"))).toThrow(/not a WAV/);
  });

  test("frames the speech 12 dB down, after 1 s of silence and before 3 s more", () => {
    const speech = Int16Array.from({ length: 100 }, () => 10_000);
    const all = framed(speech);
    expect(all.length).toBe(RATE + 100 + 3 * RATE);
    expect(all.slice(0, RATE).every((sample) => sample === 0)).toBe(true);
    expect(all[RATE]).toBe(Math.round(10_000 * 10 ** (-12 / 20)));
    expect(all.slice(RATE + 100).every((sample) => sample === 0)).toBe(true);
  });
});

describe("the dev smoke's steps", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "eidolon-dev-smoke-test-"));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  test("a passing step's line gives what each check found", () => {
    const checks = [
      { name: "first", pass: true, detail: "it streamed" },
      { name: "second", pass: true, detail: "" },
    ];
    expect(stepLine(checks, null)).toBe("it streamed; second");
  });

  test("a failing step's line gives only what failed, and why it stopped", () => {
    const checks = [
      { name: "first", pass: true, detail: "fine" },
      { name: "second", pass: false, detail: "no reply" },
    ];
    expect(stepLine(checks, null)).toBe("second: no reply");
    expect(stepLine(checks, "it timed out")).toBe("second: no reply; it stopped: it timed out");
  });

  test("a Playwright timeout names what it waited for", () => {
    const error = new Error(
      "locator.click: Timeout 15000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Theme' })\n",
    );
    expect(described(error)).toBe(
      "locator.click: Timeout 15000ms exceeded. (waiting for getByRole('button', { name: 'Theme' }))",
    );
    expect(described(new Error("one line\nand more"))).toBe("one line");
    expect(described("thrown text")).toBe("thrown text");
  });

  test("each step adds one check, and a throw fails it with what it had checked", async () => {
    const checks = new Checks();
    const steps = new Steps(checks, folder);
    let during: string | null = null;
    expect(
      await steps.run("passes", async (step) => {
        during = steps.current;
        step.check("a check", true, "found");
      }),
    ).toBe(true);
    expect(during).toBe("passes");
    expect(steps.current).toBeNull();
    expect(
      await steps.run("throws", async (step) => {
        step.check("before it", false, "wrong");
        throw new Error("gone\nstack");
      }),
    ).toBe(false);
    expect(await steps.run("checks nothing", async () => {})).toBe(false);
    expect(checks.list.map(({ name, pass, detail }) => [name, pass, detail])).toEqual([
      ["passes", true, "found"],
      ["throws", false, "before it: wrong; it stopped: gone"],
      ["checks nothing", false, "it stopped: it checked nothing"],
    ]);
    expect(steps.records.map((record) => [record.name, record.pass, record.error])).toEqual([
      ["passes", true, null],
      ["throws", false, "gone"],
      ["checks nothing", false, "it checked nothing"],
    ]);
  });

  test("writes the results as results.json", () => {
    const file = writeResults(folder, { smoke: "dev", steps: [] });
    expect(file).toBe(join(folder, "results.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ smoke: "dev", steps: [] });
  });
});

describe("the window watch's looks", () => {
  test("reads each look the script prints", () => {
    expect(parseLook('{"looks":3,"maxGapMs":61,"windows":58,"fresh":[615,10609]}')).toEqual({
      looks: 3,
      maxGapMs: 61,
      windows: 58,
      fresh: [615, 10609],
    });
    expect(parseLook('{"looks":4,"maxGapMs":61,"windows":58,"fresh":[]}')?.fresh).toEqual([]);
  });

  test("takes nothing else osascript prints for a look", () => {
    expect(
      parseLook("execution error: Error: ReferenceError: Can't find variable (-2700)"),
    ).toBeNull();
    expect(parseLook("null")).toBeNull();
    expect(parseLook('{"looks":3,"maxGapMs":61,"windows":58}')).toBeNull();
    expect(parseLook('{"looks":3,"maxGapMs":61,"windows":58,"fresh":["615"]}')).toBeNull();
    expect(parseLook('{"looks":"3","maxGapMs":61,"windows":58,"fresh":[]}')).toBeNull();
  });
});

// The stand-in osascript is a POSIX script.
describe.skipIf(process.platform === "win32")("the window watch", () => {
  let bin: string;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "eidolon-window-watch-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(bin, { recursive: true, force: true });
  });

  test("reads every look osascript printed before it stops, the last after it exits", async () => {
    // A child of its own prints the last look 300 ms in, past the stop's SIGTERM, on its stderr.
    writeFileSync(
      join(bin, "osascript"),
      [
        "#!/bin/sh",
        `echo '{"looks":1,"maxGapMs":0,"windows":3,"fresh":[]}' >&2`,
        `(sleep 0.3; echo '{"looks":2,"maxGapMs":50,"windows":4,"fresh":[]}' >&2) &`,
        "exec sleep 30",
      ].join("\n"),
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
    const watch = watchWindows({ ours: async () => [], skip: null, doing: () => "the test" });
    await watch.ready;
    expect(await watch.stop()).toMatchObject({ looks: 2, windows: 4, failures: [] });
  });
});
