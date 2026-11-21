// An onnxruntime CPU session on the payload's Silero model, run by the app binary as Node, as a
// call's voice detection opens it (packages/voice/src/input/onnx.ts and vad.ts). Prints JSON: the
// speech probability, and every loaded native and runtime DLL with its path.
// usage: ELECTRON_RUN_AS_NODE=1 <app binary> --disable-sigusr1 ort-check.cjs <payload dir>
"use strict";
const path = require("node:path");

const payload = process.argv[2];
process.env.ORT_DISABLE_TELEMETRY ??= "1";
(async () => {
  const ort = require(path.join(payload, "node_modules", "onnxruntime-node"));
  const model = path.join(payload, "data", "models", "silero_vad.onnx");
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ["cpu"],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
    graphOptimizationLevel: "all",
  });
  const out = await session.run({
    input: new ort.Tensor("float32", new Float32Array(576), [1, 576]),
    state: new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]),
    sr: new ort.Tensor("int64", BigInt64Array.of(16000n), []),
  });
  const probability = out[session.outputNames[0]].data[0];
  const shared = process.report.getReport().sharedObjects;
  console.log(
    JSON.stringify({
      ok: typeof probability === "number" && probability >= 0 && probability <= 1,
      probability,
      inputNames: session.inputNames,
      outputNames: session.outputNames,
      execPath: process.execPath,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      execArgv: process.execArgv,
      loaded: shared.filter((p) =>
        /onnxruntime|directml|dxcompiler|dxil|vcruntime140|msvcp140|lancedb|sharp|vips/i.test(path.basename(p)),
      ),
    }),
  );
})().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: String(error?.stack ?? error) }));
  process.exitCode = 1;
});
