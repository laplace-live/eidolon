// e2e-compare.ts run on made-up reports: its pass bar, as the JSON it writes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../scripts/e2e-compare.ts");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-compare-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A text-mode report: her greeting and her reply, each as `spans`, stopped `stoppedAfter` ms after the last. */
function report(spans: [number, number][][], stoppedAfter = 50): unknown {
  const timeline: unknown[] = [
    { t: 0, source: "rtvi", event: "transportStateChanged", data: "connected" },
  ];
  const turn = (start: number, own: [number, number][]) => {
    const end = own.at(-1)?.[1] ?? start + 500;
    timeline.push(
      { t: start, source: "rtvi", event: "botTtsStarted" },
      { t: start + 200, source: "rtvi", event: "botStartedSpeaking" },
      { t: start + 300, source: "rtvi", event: "botTtsStopped" },
      { t: end + stoppedAfter, source: "rtvi", event: "botStoppedSpeaking" },
    );
  };
  const [greeting = [], reply = []] = spans;
  turn(100, greeting);
  timeline.push({ t: 5_000, source: "harness", event: "askText" });
  turn(5_100, reply);
  return {
    harness: { mode: "text", engine: null, baseUrl: "http://x", startedAt: "2026-11-10T00:00:00Z" },
    checks: [],
    latencyMs: { questionEndToReplyAudio: 1_000 },
    stagesMs: {},
    invariants: [],
    audibleSpans: { bot: [...greeting, ...reply], mic: [] },
    timeline,
  };
}

/** The candidate's pass bar against the baseline, by check name. */
async function bar(baseline: unknown, candidate: unknown): Promise<Record<string, boolean>> {
  const files = ["base.json", "cand.json", "out.json"].map((name) => join(dir, name));
  await Bun.write(files[0] as string, JSON.stringify(baseline));
  await Bun.write(files[1] as string, JSON.stringify(candidate));
  const run = Bun.spawn(
    ["bun", SCRIPT, files[0] as string, files[1] as string, "--json", files[2] as string],
    {
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  await run.exited;
  const out = (await Bun.file(files[2] as string).json()) as {
    modes: { text: { bar: { name: string; pass: boolean }[] } };
  };
  return Object.fromEntries(out.modes.text.bar.map((check) => [check.name, check.pass]));
}

const SMOOTH = [[[300, 2_000]], [[5_300, 7_000]]] as [number, number][][];

test("a call with no gaps between her sentences has gaps of none; one with no audio fails", async () => {
  const gapped = report([
    [
      [300, 1_000],
      [1_200, 2_000],
    ],
    [[5_300, 7_000]],
  ]);
  expect((await bar(report(SMOOTH), report(SMOOTH)))["gap between sentences"]).toBe(true);
  expect((await bar(gapped, report(SMOOTH)))["gap between sentences"]).toBe(true);
  expect((await bar(report(SMOOTH), report([])))["gap between sentences"]).toBe(false);
});

test("bot-stopped-speaking may come early only by the recorder's sampling interval", async () => {
  const onTime = async (stoppedAfter: number) =>
    (await bar(report(SMOOTH), report(SMOOTH, stoppedAfter)))["stopped speaking on time"];
  expect([await onTime(500), await onTime(501)]).toEqual([true, false]);
  expect([await onTime(-100), await onTime(-101)]).toEqual([true, false]);
});
