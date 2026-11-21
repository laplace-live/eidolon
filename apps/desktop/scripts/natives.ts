// Loads a payload's native modules on a given runtime, as the backend loads them: LanceDB writes and
// opens a table, onnxruntime runs Silero on a CPU session, and sharp makes and reads a JPEG. The
// stage test runs it on Node; the packaged app's binary runs it in node mode.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run as `<runtime> natives.mjs <payload> <LanceDB's package for this platform>`. */
const SCRIPT = `
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [payload, lancedb] = process.argv.slice(2);
const require = createRequire(join(payload, "package.json"));
const dir = mkdtempSync(join(tmpdir(), "eidolon-natives-"));
try {
  const arrow = require("apache-arrow");
  const { Connection } = require(lancedb);
  const db = await Connection.new(dir, {});
  const ipc = arrow.tableToIPC(arrow.tableFromArrays({ id: Int32Array.of(1, 2) }), "file");
  await db.createTable("natives", Buffer.from(ipc), "create");
  const rows = await (await db.openTable("natives")).countRows();
  const ort = require("onnxruntime-node");
  const session = await ort.InferenceSession.create(
    join(payload, "data", "models", "silero_vad.onnx"),
    { executionProviders: ["cpu"], intraOpNumThreads: 1, interOpNumThreads: 1 },
  );
  const out = await session.run({
    input: new ort.Tensor("float32", new Float32Array(576), [1, 576]),
    state: new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]),
    sr: new ort.Tensor("int64", BigInt64Array.of(16000n), []),
  });
  const sharp = require("sharp");
  const made = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#e33" } })
    .jpeg()
    .toBuffer();
  const { format, width, height } = await sharp(made).metadata();
  const loaded = process.report
    .getReport()
    .sharedObjects.map((path) => path.replace(/^\\\\\\\\\\?\\\\/, ""))
    .filter((path) => /onnxruntime|lancedb|sharp|vips|vcruntime|msvcp/i.test(path));
  console.log(JSON.stringify({
    rows,
    speech: out[session.outputNames[0]].data[0],
    image: format + " " + width + "x" + height,
    loaded,
  }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
`;

export interface NativesReport {
  /** The rows LanceDB counts in the table it wrote and opened: 2. */
  readonly rows: number;
  /** Silero's speech probability for a silent window, from 0 to 1. */
  readonly speech: number;
  /** What sharp reads back of the JPEG it made: `jpeg 2x1`. */
  readonly image: string;
  /** The natives and runtime libraries the process mapped, by path. */
  readonly loaded: readonly string[];
}

export interface Runtime {
  readonly command: string;
  /** Before the script. */
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/** Runs the check on `runtime` against `payload`; throws with its output when it fails. */
export function checkNatives(payload: string, lancedb: string, runtime: Runtime): NativesReport {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-natives-check-"));
  try {
    const script = join(dir, "natives.mjs");
    writeFileSync(script, SCRIPT);
    const run = spawnSync(runtime.command, [...(runtime.args ?? []), script, payload, lancedb], {
      encoding: "utf8",
      env: runtime.env ?? process.env,
      timeout: 60_000,
    });
    const line = run.stdout?.trim().split("\n").at(-1) ?? "";
    if (run.status !== 0 || !line.startsWith("{")) {
      throw new Error(`The natives check exited ${run.status}:\n${run.stdout}\n${run.stderr}`);
    }
    return JSON.parse(line) as NativesReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
