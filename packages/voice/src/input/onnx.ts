// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/onnx/src/native.ts@ce8f8bc and packages/onnx/src/shared.ts@ce8f8bc
//
// One onnxruntime-node session per model file, shared by every call: Silero passes its recurrent
// state in and out, and Smart Turn keeps none.
import type { InferenceSession, Tensor } from "onnxruntime-node";

type Ort = typeof import("onnxruntime-node");

export type OnnxTensor =
  | { readonly type: "float32"; readonly data: Float32Array; readonly dims: readonly number[] }
  | { readonly type: "int64"; readonly data: BigInt64Array; readonly dims: readonly number[] };

export interface OnnxSession {
  readonly outputNames: readonly string[];
  /** Every output by name; both models' outputs are float32. */
  run(feeds: Readonly<Record<string, OnnxTensor>>): Promise<Record<string, Float32Array>>;
}

// What pipedog gave each model: Silero forced the CPU provider with one thread each way, and
// Smart Turn added sequential execution and every graph optimization.
const SESSION_OPTIONS: InferenceSession.SessionOptions = {
  executionProviders: ["cpu"],
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  executionMode: "sequential",
  graphOptimizationLevel: "all",
};

let ort: Promise<Ort> | null = null;
const sessions = new Map<string, Promise<OnnxSession>>();

// Imported on first use, so loading the package never loads the native addon.
function loadOrt(): Promise<Ort> {
  ort ??= import("onnxruntime-node").then((mod: any) => (mod.InferenceSession ? mod : mod.default));
  return ort;
}

function wrap(ort: Ort, session: InferenceSession): OnnxSession {
  return {
    outputNames: session.outputNames,
    async run(feeds) {
      const input: Record<string, Tensor> = {};
      for (const [name, t] of Object.entries(feeds)) {
        input[name] =
          t.type === "float32"
            ? new ort.Tensor("float32", t.data, t.dims)
            : new ort.Tensor("int64", t.data, t.dims);
      }
      const results = await session.run(input);
      const out: Record<string, Float32Array> = {};
      for (const [name, t] of Object.entries(results)) out[name] = t.data as Float32Array;
      return out;
    },
  };
}

/**
 * The shared session for the model file at `path`, loaded on first use. A failed load isn't kept,
 * so the next caller tries again.
 */
export function sharedSession(path: string): Promise<OnnxSession> {
  const existing = sessions.get(path);
  if (existing) return existing;
  const created = loadOrt().then(async (o) =>
    wrap(o, await o.InferenceSession.create(path, SESSION_OPTIONS)),
  );
  sessions.set(path, created);
  created.catch(() => {
    if (sessions.get(path) === created) sessions.delete(path);
  });
  return created;
}
