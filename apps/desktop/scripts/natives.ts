// Loads a payload's native modules on a given runtime, as the backend loads them: Zvec writes and
// opens a collection, onnxruntime runs Silero on a CPU session, and sharp makes and reads a JPEG.
// The stage test runs it on Node; the packaged app's binary runs it in node mode.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VC_RUNTIME_DLLS } from "../../eidolon/src/launcher.ts";

/** Run as `<runtime> natives.mjs <payload> <Zvec's binding package for this platform>`. */
const SCRIPT = `
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [payload, zvecBinding] = process.argv.slice(2);
const require = createRequire(join(payload, "package.json"));
const dir = mkdtempSync(join(tmpdir(), "eidolon-natives-"));
try {
  require.resolve(zvecBinding);
  const { ZVecCollectionSchema, ZVecCreateAndOpen, ZVecDataType, ZVecIndexType, ZVecMetricType, ZVecOpen } =
    require("@zvec/zvec");
  const tableDir = join(dir, "natives");
  const col = ZVecCreateAndOpen(tableDir, new ZVecCollectionSchema({
    name: "natives",
    vectors: {
      name: "vector",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 2,
      indexParams: { indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE },
    },
  }));
  col.upsertSync([
    { id: "1", vectors: { vector: [1, 0] } },
    { id: "2", vectors: { vector: [0, 1] } },
  ]);
  await col.optimize();
  col.closeSync();
  const opened = ZVecOpen(tableDir, { readOnly: true });
  const rows = opened.stats.docCount;
  opened.closeSync();
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
  console.log(JSON.stringify({
    rows,
    speech: out[session.outputNames[0]].data[0],
    image: format + " " + width + "x" + height,
    mapped: process.report.getReport().sharedObjects,
  }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
`;

export interface NativesReport {
  /** The rows Zvec counts in the collection it wrote and opened: 2. */
  readonly rows: number;
  /** Silero's speech probability for a silent window, from 0 to 1. */
  readonly speech: number;
  /** What sharp reads back of the JPEG it made: `jpeg 2x1`. */
  readonly image: string;
  /** The natives and VC++ runtime DLLs the process mapped, by path: payloadLibraries' pick. */
  readonly loaded: readonly string[];
}

/**
 * Of the libraries a process mapped, by path, the natives' and the VC++ runtime DLLs the payload
 * ships, each by its file's name: Windows' own msvcp_win.dll is in every process with a window.
 */
export function payloadLibraries(mapped: readonly string[]): string[] {
  return mapped
    .map((path) => path.replace(/^\\\\\?\\/, ""))
    .filter((path) => {
      const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
      return /onnxruntime|zvec|sharp|vips/.test(name) || VC_RUNTIME_DLLS.includes(name);
    });
}

export interface Runtime {
  readonly command: string;
  /** Before the script. */
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/** Runs the check on `runtime` against `payload`; throws with its output when it fails. */
export function checkNatives(
  payload: string,
  zvecBinding: string,
  runtime: Runtime,
): NativesReport {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-natives-check-"));
  try {
    const script = join(dir, "natives.mjs");
    writeFileSync(script, SCRIPT);
    const run = spawnSync(
      runtime.command,
      [...(runtime.args ?? []), script, payload, zvecBinding],
      {
        encoding: "utf8",
        env: runtime.env ?? process.env,
        timeout: 60_000,
      },
    );
    const line = run.stdout?.trim().split("\n").at(-1) ?? "";
    if (run.error !== undefined || run.status !== 0 || !line.startsWith("{")) {
      // spawnSync's error is a failed start, or its timeout, whose kill names the signal.
      const how =
        run.error === undefined
          ? `exited ${run.status ?? run.signal}`
          : `failed: ${run.error.message}${run.signal === null ? "" : `, ended by ${run.signal}`}`;
      throw new Error(`The natives check ${how}:\n${run.stdout ?? ""}\n${run.stderr ?? ""}`);
    }
    const { mapped, ...report } = JSON.parse(line) as Omit<NativesReport, "loaded"> & {
      mapped: string[];
    };
    return { ...report, loaded: payloadLibraries(mapped) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
