import { describe, expect, test } from "vitest";
import type { CompanionShape, WindowSize } from "@/lib/desktop";
import { companionShape, type HandshakeSteps, handshake } from "./handshake";

const BOX = { x: 0, y: 0, width: 42, height: 100 };

/**
 * Steps that record their calls; `shape` answers as given, and `sized` and `frame` run inside their
 * step, before it resolves.
 */
function recorded(
  o: {
    readonly hidden?: boolean;
    readonly shape?: (shape: CompanionShape) => Promise<WindowSize>;
    readonly sized?: () => void;
    readonly frame?: () => void;
  } = {},
) {
  const calls: unknown[][] = [];
  const steps: HandshakeSteps = {
    shape: (shape) => {
      calls.push(["shape", shape]);
      return o.shape?.(shape) ?? Promise.resolve({ width: 202, height: 480 });
    },
    sized: async (size) => {
      calls.push(["sized", size]);
      o.sized?.();
    },
    hidden: () => o.hidden ?? false,
    frame: async (view) => {
      calls.push(["frame", view]);
      o.frame?.();
    },
    drawn: (view) => {
      calls.push(["drawn", view]);
    },
  };
  return { calls, steps };
}

describe("handshake", () => {
  test("her model: shaped by its box, sized, a frame drawn, then drawn, in that order", async () => {
    const { calls, steps } = recorded();
    await handshake("model", BOX, steps, new AbortController().signal);
    expect(calls).toEqual([
      ["shape", { kind: "model", aspect: 0.42 }],
      ["sized", { width: 202, height: 480 }],
      ["frame", "model"],
      ["drawn", "model"],
    ]);
  });

  test("her picture: shaped as one", async () => {
    const { calls, steps } = recorded();
    await handshake("picture", null, steps, new AbortController().signal);
    expect(calls).toEqual([
      ["shape", { kind: "picture" }],
      ["sized", { width: 202, height: 480 }],
      ["frame", "picture"],
      ["drawn", "picture"],
    ]);
  });

  test("a hidden window waits for no frame, which it would never draw", async () => {
    const { calls, steps } = recorded({ hidden: true });
    await handshake("model", BOX, steps, new AbortController().signal);
    expect(calls.map(([step]) => step)).toEqual(["shape", "sized", "drawn"]);
  });

  test("an abort once the shape is answered stops it there", async () => {
    const controller = new AbortController();
    const { calls, steps } = recorded({
      shape: async () => {
        controller.abort();
        return { width: 202, height: 480 };
      },
    });
    await handshake("model", BOX, steps, controller.signal);
    expect(calls.map(([step]) => step)).toEqual(["shape"]);
  });

  test("an abort while her window takes its size stops it there", async () => {
    const controller = new AbortController();
    const { calls, steps } = recorded({ sized: () => controller.abort() });
    await handshake("model", BOX, steps, controller.signal);
    expect(calls.map(([step]) => step)).toEqual(["shape", "sized"]);
  });

  test("an abort while a frame of her is drawn never says she is", async () => {
    const controller = new AbortController();
    const { calls, steps } = recorded({ frame: () => controller.abort() });
    await handshake("model", BOX, steps, controller.signal);
    expect(calls.map(([step]) => step)).toEqual(["shape", "sized", "frame"]);
  });

  test("an abort before it starts asks nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, steps } = recorded();
    await handshake("model", BOX, steps, controller.signal);
    expect(calls).toEqual([]);
  });

  test("a shape main refuses says nothing, and the handshake resolves", async () => {
    const { calls, steps } = recorded({
      shape: () => Promise.reject(new Error("refused")),
    });
    await expect(handshake("model", BOX, steps, new AbortController().signal)).resolves.toBe(
      undefined,
    );
    expect(calls.map(([step]) => step)).toEqual(["shape"]);
  });
});

describe("companionShape", () => {
  test("her box's aspect, clamped into what her window takes", () => {
    expect(companionShape("model", { x: 0, y: 0, width: 10, height: 1000 })).toEqual({
      kind: "model",
      aspect: 0.1,
    });
    expect(companionShape("model", { x: 0, y: 0, width: 1000, height: 100 })).toEqual({
      kind: "model",
      aspect: 4,
    });
    expect(companionShape("model", BOX)).toEqual({ kind: "model", aspect: 0.42 });
    expect(companionShape("picture", BOX)).toEqual({ kind: "picture" });
  });
});
