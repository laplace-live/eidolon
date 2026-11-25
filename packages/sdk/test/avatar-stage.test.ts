// The stage with a fake model and a clock the test moves: the loop's pauses, caps and errors, and
// how a direction reaches the model.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Direction, directionOf, directionState } from "../src/avatar/direct.ts";
import { viewFor } from "../src/avatar/framing.ts";
import {
  AvatarError,
  type AvatarModel,
  type ModelInventory,
  resolveSetup,
} from "../src/avatar/model.ts";
import { AvatarStage, type FrameClock } from "../src/avatar/stage.ts";

class FakeClock implements FrameClock {
  #next = 1;
  readonly pending = new Map<number, (now: number) => void>();

  request = (frame: (now: number) => void): number => {
    const handle = this.#next++;
    this.pending.set(handle, frame);
    return handle;
  };

  cancel = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** Runs the frames requested so far, at `now`. */
  frame(now: number): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const frame of due) frame(now);
  }
}

class FakeCanvas extends EventTarget {
  clientWidth = 400;
  clientHeight = 500;
  getBoundingClientRect() {
    return { left: 100, top: 50, width: 400, height: 500 };
  }
}

const clip = (name: string) => ({
  id: `${name.toLowerCase()}-id`,
  name,
  group: name,
  duration: 1,
  looping: name === "Idle",
});

const INVENTORY: ModelInventory = {
  runtime: "0.1.0",
  generator: null,
  canvas: { width: 2048, height: 2048 },
  clips: ["Idle", "Talk", "Nod", "Shake"].map(clip),
  expressions: ["smile", "sleepy", "sad", "surprised"].map((id) => ({ id, name: id })),
  hitAreas: [{ id: "HitAreaHead", name: "Head" }],
  parameters: [],
  parts: [],
  poseGroups: [],
  lipSync: true,
  textures: 1,
};

const SETUP = resolveSetup(INVENTORY);

function fakeModel() {
  return {
    kind: "psd2live" as const,
    inventory: INVENTORY,
    setExpressions: vi.fn<AvatarModel["setExpressions"]>(),
    play: vi.fn<AvatarModel["play"]>(),
    mouth: vi.fn<AvatarModel["mouth"]>(),
    lookAt: vi.fn<AvatarModel["lookAt"]>(),
    lookStrength: vi.fn<AvatarModel["lookStrength"]>(),
    wear: vi.fn<AvatarModel["wear"]>(),
    bounds: vi.fn<AvatarModel["bounds"]>(() => null),
    update: vi.fn<AvatarModel["update"]>(),
    draw: vi.fn<AvatarModel["draw"]>(),
    hitTest: vi.fn<AvatarModel["hitTest"]>(() => null),
    alphaAt: vi.fn<AvatarModel["alphaAt"]>(() => 0.5),
    dispose: vi.fn<AvatarModel["dispose"]>(),
  } satisfies AvatarModel;
}

const NEUTRAL = directionOf(directionState());

function direction(o: Partial<Direction>): Direction {
  return { ...NEUTRAL, ...o };
}

let clock: FakeClock;
let canvas: FakeCanvas;

beforeEach(() => {
  clock = new FakeClock();
  canvas = new FakeCanvas();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stageOf(o: ConstructorParameters<typeof AvatarStage>[1] = {}): AvatarStage {
  return new AvatarStage(canvas as unknown as HTMLCanvasElement, { clock, ...o });
}

describe("the loop", () => {
  test("draws a frame at a time, at the capped pixel ratio, framing the box", () => {
    vi.stubGlobal("devicePixelRatio", 3);
    const stage = stageOf();
    const model = fakeModel();
    expect(clock.pending.size).toBe(0);
    stage.show(model, SETUP);
    const box = { x: 700, y: 0, width: 660, height: 830 };
    stage.frame(box);
    clock.frame(0);
    expect(model.draw).toHaveBeenLastCalledWith(
      2,
      viewFor(box, INVENTORY.canvas, { width: 400, height: 500 }),
    );
    expect(model.update).toHaveBeenLastCalledWith(0);
    expect(model.play).toHaveBeenCalledWith("idle-id", 0, { loop: true });
    clock.frame(16);
    expect(model.update).toHaveBeenLastCalledWith(0.016);
    expect(model.draw).toHaveBeenCalledTimes(2);
    expect(stage.model).toBe(model);

    vi.stubGlobal("devicePixelRatio", 1.5);
    clock.frame(32);
    expect(model.draw).toHaveBeenLastCalledWith(1.5, expect.anything());
  });

  test("frames the whole canvas until told otherwise", () => {
    const stage = stageOf();
    const model = fakeModel();
    stage.show(model, SETUP);
    clock.frame(0);
    expect(model.draw).toHaveBeenLastCalledWith(1, { zoom: 1, x: 0, y: 0 });
  });

  test("steps at most 0.1 s, and caps frames to its fps", () => {
    const model = fakeModel();
    stageOf().show(model, SETUP);
    clock.frame(0);
    clock.frame(1000);
    expect(model.update).toHaveBeenLastCalledWith(0.1);

    const capped = fakeModel();
    clock = new FakeClock();
    stageOf({ fps: 30 }).show(capped, SETUP);
    for (const now of [0, 16.7, 33.3, 50, 66.7]) clock.frame(now);
    expect(capped.draw).toHaveBeenCalledTimes(3);
    expect(capped.update.mock.calls[1]?.[0]).toBeCloseTo(0.0333);
  });

  test("pauses when paused, hidden or off screen, and steps from zero after", () => {
    const visibility = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal("document", visibility);
    let observed: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          observed = callback;
        }
        observe() {}
        disconnect() {
          observed = null;
        }
      },
    );
    const stage = stageOf();
    const model = fakeModel();
    stage.show(model, SETUP);
    clock.frame(0);
    expect(clock.pending.size).toBe(1);

    stage.pause();
    expect(clock.pending.size).toBe(0);
    stage.resume();
    expect(clock.pending.size).toBe(1);
    clock.frame(5000);
    expect(model.update).toHaveBeenLastCalledWith(0);

    visibility.hidden = true;
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(clock.pending.size).toBe(0);
    visibility.hidden = false;
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(clock.pending.size).toBe(1);

    (observed as ((entries: { isIntersecting: boolean }[]) => void) | null)?.([
      { isIntersecting: false },
    ]);
    expect(clock.pending.size).toBe(0);
    (observed as ((entries: { isIntersecting: boolean }[]) => void) | null)?.([
      { isIntersecting: true },
    ]);
    expect(clock.pending.size).toBe(1);

    stage.dispose();
    expect(clock.pending.size).toBe(0);
    expect(observed).toBeNull();
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(clock.pending.size).toBe(0);
  });

  test("a hidden page starts paused", () => {
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: true }));
    const stage = stageOf();
    stage.show(fakeModel(), SETUP);
    expect(clock.pending.size).toBe(0);
  });
});

describe("her direction", () => {
  test("shows her mood, talks while she speaks, and plays each gesture once", () => {
    const stage = stageOf();
    const model = fakeModel();
    stage.show(model, SETUP);
    stage.direct(
      direction({ mood: ["lazy", "happy"], speaking: true, gesture: { name: "nod", seq: 1 } }),
    );
    clock.frame(0);
    expect(model.setExpressions).toHaveBeenLastCalledWith(["sleepy", "smile"]);
    expect(model.play).toHaveBeenCalledWith("talk-id", 1, { loop: true });
    expect(model.play).toHaveBeenCalledWith("nod-id", 2, { priority: 2 });

    model.play.mockClear();
    model.setExpressions.mockClear();
    clock.frame(16);
    expect(model.play).not.toHaveBeenCalled();
    expect(model.setExpressions).not.toHaveBeenCalled();

    // A lent mood shows first when two can't fit.
    stage.direct(
      direction({
        mood: ["lazy", "happy"],
        pulse: "surprised",
        gesture: { name: "shake", seq: 2 },
      }),
    );
    clock.frame(32);
    expect(model.setExpressions).toHaveBeenLastCalledWith(["surprised", "sleepy"]);
    expect(model.play).toHaveBeenCalledWith(null, 1, { loop: true });
    expect(model.play).toHaveBeenCalledWith("shake-id", 2, { priority: 2 });
  });

  test("under reduced motion, keeps her face and mouth but plays no clip, idle included", () => {
    const stage = stageOf({ reducedMotion: true });
    const model = fakeModel();
    stage.show(model, SETUP);
    stage.direct(direction({ mood: ["sad"], speaking: true, gesture: { name: "nod", seq: 1 } }));
    stage.mouth({ read: () => 0.6 });
    clock.frame(0);
    expect(model.play).not.toHaveBeenCalled();
    expect(model.setExpressions).toHaveBeenLastCalledWith(["sad"]);
    expect(model.mouth).toHaveBeenLastCalledWith(0.6);
    expect(model.lookAt).toHaveBeenLastCalledWith(0, 0);
    stage.direct(direction({ looking: "away" }));
    clock.frame(16);
    expect(model.lookAt).toHaveBeenLastCalledWith(0.35, 0.45);
  });

  test("looks at the viewer, away, or around her", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    const stage = stageOf();
    const model = fakeModel();
    stage.show(model, SETUP);
    stage.direct(direction({ looking: "viewer" }));
    clock.frame(0);
    expect(model.lookAt).toHaveBeenLastCalledWith(0, 0);

    stage.direct(direction({ looking: "away" }));
    clock.frame(1000);
    const [x = 0, y = 0] = model.lookAt.mock.lastCall ?? [];
    expect(Math.abs(x - 0.35)).toBeLessThanOrEqual(0.04);
    expect(Math.abs(y - 0.45)).toBeLessThanOrEqual(0.03);

    stage.direct(direction({ looking: "idle" }));
    clock.frame(2000);
    expect(model.lookAt).toHaveBeenLastCalledWith(0.15, 0.15);
    random.mockReturnValue(0);
    clock.frame(6900);
    expect(model.lookAt).toHaveBeenLastCalledWith(0.15, 0.15);
    clock.frame(7000);
    expect(model.lookAt).toHaveBeenLastCalledWith(-0.15, -0.15);

    stage.gaze([0.5, -0.2]);
    clock.frame(7016);
    expect(model.lookAt).toHaveBeenLastCalledWith(0.5, -0.2);
  });

  test("follows the pointer across the canvas", () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const stage = stageOf();
    const model = fakeModel();
    stage.show(model, SETUP);
    stage.gaze("pointer");
    clock.frame(0);
    expect(model.lookAt).toHaveBeenLastCalledWith(0, 0);
    page.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 500, clientY: 50 }));
    clock.frame(16);
    expect(model.lookAt).toHaveBeenLastCalledWith(1, 1);
    page.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 200, clientY: 425 }));
    clock.frame(32);
    expect(model.lookAt).toHaveBeenLastCalledWith(-0.5, -0.5);
    stage.gaze("direction");
    page.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 500, clientY: 50 }));
    stage.gaze("pointer");
    clock.frame(48);
    expect(model.lookAt).toHaveBeenLastCalledWith(-0.5, -0.5);
  });

  test("moves her mouth as its source reads, shut without one", () => {
    const stage = stageOf();
    const model = fakeModel();
    stage.show(model, SETUP);
    const read = vi.fn((_dt: number) => 0.7);
    stage.mouth({ read });
    clock.frame(0);
    clock.frame(20);
    expect(read).toHaveBeenLastCalledWith(0.02);
    expect(model.mouth).toHaveBeenLastCalledWith(0.7);
    stage.mouth({
      read: () => {
        throw new Error("the track ended");
      },
    });
    clock.frame(40);
    expect(model.mouth).toHaveBeenLastCalledWith(0);
    expect(model.dispose).not.toHaveBeenCalled();
    stage.mouth(null);
    clock.frame(60);
    expect(model.mouth).toHaveBeenLastCalledWith(0);
  });

  test("a new setup for the model shown changes her face without starting her clips over", () => {
    const stage = stageOf();
    const model = fakeModel();
    stage.show(model, SETUP);
    stage.direct(direction({ mood: ["happy"], speaking: true }));
    clock.frame(0);
    expect(model.setExpressions).toHaveBeenLastCalledWith(["smile"]);
    model.play.mockClear();
    model.wear.mockClear();

    stage.show(model, resolveSetup(INVENTORY, { moods: { happy: ["sad"] } }));
    clock.frame(16);
    expect(model.play).not.toHaveBeenCalled();
    expect(model.wear).not.toHaveBeenCalled();
    expect(model.setExpressions).toHaveBeenLastCalledWith(["sad"]);
    expect(model.update).toHaveBeenLastCalledWith(0.016);

    // A clip the setup changed starts in the old one's place.
    stage.show(model, resolveSetup(INVENTORY, { gestures: { idle: "nod-id", talk: "shake-id" } }));
    clock.frame(32);
    expect(model.play.mock.calls).toEqual([
      ["nod-id", 0, { loop: true }],
      ["shake-id", 1, { loop: true }],
    ]);
  });

  test("a clip the new setup takes away stops, even once she has stopped speaking", () => {
    const stage = stageOf();
    const model = fakeModel();
    stage.show(model, SETUP);
    stage.direct(direction({ speaking: true }));
    clock.frame(0);
    model.play.mockClear();

    stage.show(model, { ...SETUP, gestures: { ...SETUP.gestures, idle: null, talk: null } });
    clock.frame(16);
    expect(model.play.mock.calls).toEqual([
      [null, 0, { loop: true }],
      [null, 1, { loop: true }],
    ]);

    stage.show(model, SETUP);
    clock.frame(32);
    model.play.mockClear();
    // Her talk clip changes as she stops speaking, before a frame plays the new one.
    stage.show(model, resolveSetup(INVENTORY, { gestures: { talk: "shake-id" } }));
    stage.direct(direction({ speaking: false }));
    clock.frame(48);
    expect(model.play.mock.calls).toEqual([[null, 1, { loop: true }]]);
  });

  test("turns her as far as each setup's look says, applied once per setup shown", () => {
    const stage = stageOf();
    const first = fakeModel();
    stage.show(first, resolveSetup(INVENTORY, { look: 0.4 }));
    clock.frame(0);
    clock.frame(16);
    expect(first.lookStrength.mock.calls).toEqual([[0.4]]);

    stage.show(first, resolveSetup(INVENTORY, { look: 0.4, moods: { happy: ["sad"] } }));
    clock.frame(32);
    stage.show(first, resolveSetup(INVENTORY));
    clock.frame(48);
    expect(first.lookStrength.mock.calls).toEqual([[0.4], [0.4], [1]]);

    const second = fakeModel();
    stage.show(second, resolveSetup(INVENTORY, { look: 0 }));
    clock.frame(64);
    expect(second.lookStrength.mock.calls).toEqual([[0]]);
  });

  test("dresses each model shown in the outfit", () => {
    const stage = stageOf();
    const outfit = { poses: [{ group: 0, entry: 1 }], parameters: [], hiddenParts: [] };
    stage.wear(outfit);
    const first = fakeModel();
    stage.show(first, SETUP);
    clock.frame(0);
    expect(first.wear).toHaveBeenCalledWith(outfit);
    stage.wear(null);
    clock.frame(16);
    expect(first.wear).toHaveBeenLastCalledWith(null);
    const second = fakeModel();
    stage.show(second, SETUP);
    clock.frame(32);
    expect(second.wear).toHaveBeenCalledWith(null);
  });
});

describe("models and errors", () => {
  test("showing a model disposes the one before", () => {
    const stage = stageOf();
    const first = fakeModel();
    const second = fakeModel();
    stage.show(first, SETUP);
    stage.show(second, SETUP);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(stage.model).toBe(second);
    stage.show(second, SETUP);
    expect(second.dispose).not.toHaveBeenCalled();
    stage.dispose();
    expect(second.dispose).toHaveBeenCalledTimes(1);
    const late = fakeModel();
    stage.show(late, SETUP);
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(stage.model).toBeNull();
  });

  test("a model that throws is disposed and reported once", () => {
    const onError = vi.fn();
    const stage = stageOf({ onError });
    const model = fakeModel();
    model.update.mockImplementation(() => {
      throw new AvatarError("trap", "unreachable");
    });
    stage.show(model, SETUP);
    clock.frame(0);
    expect(model.dispose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "trap" }));
    expect(stage.model).toBeNull();
    expect(clock.pending.size).toBe(0);

    const plain = fakeModel();
    plain.draw.mockImplementation(() => {
      throw new TypeError("detached");
    });
    stage.show(plain, SETUP);
    clock.frame(16);
    const error = onError.mock.lastCall?.[0] as AvatarError;
    expect(error).toBeInstanceOf(AvatarError);
    expect([error.code, error.message]).toEqual(["trap", "detached"]);
  });

  test("a lost WebGL context counts the same", () => {
    const onError = vi.fn();
    const stage = stageOf({ onError });
    const model = fakeModel();
    stage.show(model, SETUP);
    canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(model.dispose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "lost" }));
    canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("alphaAt reads right after the next draw, and 0 with no model", async () => {
    const stage = stageOf();
    expect(await stage.alphaAt(1, 2)).toBe(0);
    const model = fakeModel();
    stage.show(model, SETUP);
    const alpha = stage.alphaAt(300, 200);
    clock.frame(0);
    expect(await alpha).toBe(0.5);
    expect(model.alphaAt).toHaveBeenCalledWith(300, 200);
    const [drawn] = model.draw.mock.invocationCallOrder;
    const [read] = model.alphaAt.mock.invocationCallOrder;
    expect(read).toBeGreaterThan(drawn ?? Number.POSITIVE_INFINITY);

    const pending = stage.alphaAt(300, 200);
    stage.dispose();
    expect(await pending).toBe(0);
  });
});
