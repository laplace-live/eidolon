// A stand-in for the CLI in the jobs tests, never the real one, whose load-env.ts would read the
// repository's .env: `bun jobs-fake-cli.ts <scenario> <command> --json [args]`. It writes progress
// events to stdout and log lines to stderr, as the CLI does.
const [scenario = "ok", command = "", ...args] = Bun.argv.slice(2);

/** The summary the real CLI ends this command line's run with. */
const runStage =
  command === "pipeline"
    ? args.includes("--dry-run")
      ? "plan"
      : "pipeline"
    : command === "download" && args.includes("--expand")
      ? "expand"
      : command === "build-stream-catalog"
        ? "catalog"
        : command;
const stage = runStage === "pipeline" ? "download" : runStage;

function emit(event: object): void {
  process.stdout.write(`${JSON.stringify({ v: 1, t: Date.now(), ...event })}\n`);
}

function summary(fields: object = {}): void {
  emit({ type: "summary", stage: runStage, ok: true, counts: {}, durationSec: 0.1, ...fields });
}

/** Runs until SIGTERM, which it answers as the CLI does: a cancelled run, then exit 143. */
function untilTerminated(): void {
  let signals = 0;
  process.on("SIGTERM", () => {
    signals++;
    process.stderr.write(`SIGTERM ${signals}\n`);
    if (signals > 1) return;
    setTimeout(() => {
      emit({ type: "stage", stage, status: "cancelled", code: "cancelled" });
      summary({ ok: false, cancelled: true });
      process.exit(143);
    }, 50);
  });
  setInterval(() => {}, 1000);
}

process.stderr.write(`fake CLI ${scenario} ${command} in ${process.cwd()}\n`);

switch (scenario) {
  case "ok":
    emit({ type: "stage", stage, status: "start", total: 2 });
    for (const [index, item] of ["a", "b"].entries()) {
      emit({ type: "item", stage, item, video: item, index: index + 1, total: 2, status: "start" });
      emit({ type: "item", stage, item, video: item, index: index + 1, total: 2, status: "done" });
    }
    emit({ type: "stage", stage, status: "done" });
    summary();
    break;

  case "plan":
    for (const id of ["BV1aaaaaaaaa", "BV1bbbbbbbbb"]) {
      emit({
        type: "plan",
        video: {
          id,
          download: "done",
          transcribe: "pending",
          refine: null,
          indexed: false,
          estimate: { basis: "price-table", transcribeUsd: 0.1 },
        },
      });
    }
    summary({ counts: { videos: 2 } });
    break;

  case "costs":
    // Two stages, a retried item, a failure with its provider, and costs from items and summaries.
    emit({ type: "stage", stage: "download", status: "start", total: 1 });
    emit({ type: "item", stage: "download", item: "u1", status: "failed", message: "HTTP 412" });
    emit({ type: "item", stage: "download", item: "u1", status: "start" });
    emit({ type: "progress", stage: "download", item: "u1", done: 10, total: 20, unit: "bytes" });
    emit({ type: "item", stage: "download", item: "u1", status: "done", outputs: ["v1"] });
    emit({ type: "stage", stage: "download", status: "done" });
    emit({ type: "summary", stage: "download", ok: true, counts: {}, durationSec: 1, costUsd: 0 });
    emit({ type: "stage", stage: "transcribe", status: "start", total: 3 });
    emit({
      type: "item",
      stage: "transcribe",
      item: "v1.m4a",
      video: "v1",
      status: "done",
      costUsd: 0.25,
    });
    emit({ type: "item", stage: "transcribe", item: "v2.m4a", video: "v2", status: "skipped" });
    emit({
      type: "item",
      stage: "transcribe",
      item: "v3.m4a",
      video: "v3",
      status: "failed",
      code: "insufficient-credits",
      provider: "soniox",
      message: "402 Payment Required",
      costUsd: 0.05,
    });
    emit({
      type: "stage",
      stage: "transcribe",
      status: "failed",
      code: "insufficient-credits",
      provider: "soniox",
    });
    emit({ type: "stage", stage: "ingest-streams", status: "start" });
    emit({ type: "progress", stage: "ingest-streams", done: 3, total: 9, unit: "chunks" });
    break;

  case "many-failures":
    emit({ type: "stage", stage, status: "start", total: 150 });
    for (let i = 0; i < 150; i++) {
      emit({ type: "item", stage, item: `f${i}`, status: "failed", message: `bad ${i}` });
    }
    emit({ type: "stage", stage, status: "failed" });
    summary({ ok: false });
    process.exit(1);
    break;

  case "crash":
    emit({ type: "stage", stage, status: "start", total: 1 });
    emit({ type: "item", stage, item: "a", status: "start" });
    for (let i = 1; i <= 60; i++) process.stderr.write(`trace line ${i}\n`);
    process.stderr.write("TypeError: boom\n");
    process.exit(1);
    break;

  case "slow":
    emit({ type: "stage", stage, status: "start" });
    untilTerminated();
    break;

  case "stubborn": {
    // Ignores SIGTERM, and has a child of its own that only a kill of the group reaches.
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    emit({ type: "stage", stage, status: "start", message: String(child.pid) });
    process.on("SIGTERM", () => process.stderr.write("ignoring SIGTERM\n"));
    setInterval(() => {}, 1000);
    break;
  }

  case "steps": {
    // Ten items 30 ms apart, the third written in two halves, then the summary.
    let index = 0;
    const timer = setInterval(() => {
      index++;
      const line = JSON.stringify({
        v: 1,
        t: Date.now(),
        type: "item",
        stage,
        item: `s${index}`,
        status: "done",
      });
      if (index === 3) {
        process.stdout.write(line.slice(0, 20));
        setTimeout(() => process.stdout.write(`${line.slice(20)}\n`), 15);
      } else {
        process.stdout.write(`${line}\n`);
      }
      if (index === 10) {
        clearInterval(timer);
        setTimeout(() => summary(), 20);
      }
    }, 30);
    break;
  }

  case "echo":
    emit({
      type: "stage",
      stage,
      status: "done",
      message: JSON.stringify({ argv: [command, ...args], cwd: process.cwd(), pid: process.pid }),
    });
    summary();
    break;

  case "env":
    emit({
      type: "stage",
      stage,
      status: "done",
      message: JSON.stringify({
        EIDOLON_NO_DOTENV: process.env.EIDOLON_NO_DOTENV ?? null,
        EIDOLON_ENV_PROBE: process.env.EIDOLON_ENV_PROBE ?? null,
      }),
    });
    summary();
    break;

  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exit(2);
}
