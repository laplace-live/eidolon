import type {
  AvatarModel,
  AvatarStageOptions,
  Direction,
  MouthSource,
  ResolvedSetup,
} from "@laplace.live/eidolon-sdk/avatar";
import { describe, expect, test } from "vitest";
import type { ActiveCharacterModel } from "@/lib/api";
import type { LoadedModel } from "./cast";
import { CallStages, type StageLike, type StageLoad, type StageParts } from "./stages";
import { type CastMember, chatTarget, soloTarget } from "./target";

const MODEL: ActiveCharacterModel = {
  id: "tml",
  name: "TML",
  kind: "psd2live",
  sha256: "0".repeat(64),
  updatedAt: "2026-11-23T00:00:00.000Z",
};

function member(id: string, model: ActiveCharacterModel | null = MODEL): CastMember {
  return { id, name: `${id} name`, shortName: id, avatar: false, appearance: { model } };
}

const NEUTRAL: Direction = {
  persona: null,
  mood: [],
  pulse: null,
  speaking: false,
  listening: false,
  thinking: false,
  looking: "idle",
  gesture: null,
};

class FakeCanvas {
  removed = 0;
  remove() {
    this.removed += 1;
  }
}

class FakeStage implements StageLike {
  readonly calls: string[] = [];
  readonly directed: Direction[] = [];
  source: MouthSource | null = null;
  disposed = 0;
  readonly options: AvatarStageOptions;
  constructor(options: AvatarStageOptions) {
    this.options = options;
  }
  show() {
    this.calls.push("show");
  }
  frame() {
    this.calls.push("frame");
  }
  direct(direction: Direction) {
    this.directed.push(direction);
  }
  mouth(source: MouthSource | null) {
    this.calls.push("mouth");
    this.source = source;
  }
  wear() {
    this.calls.push("wear");
  }
  dispose() {
    this.disposed += 1;
  }
}

function fakeParts() {
  const canvases: FakeCanvas[] = [];
  const stages: FakeStage[] = [];
  const parts: StageParts = {
    canvas: () => {
      const canvas = new FakeCanvas();
      canvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    },
    stage: async (_canvas, options) => {
      const stage = new FakeStage(options);
      stages.push(stage);
      return stage;
    },
  };
  return { parts, canvases, stages };
}

function fakeSignals() {
  const listeners = new Set<() => void>();
  const speaking = new Set<string>();
  const meter: MouthSource = { read: () => 0.5 };
  return {
    meter,
    speaking,
    mouth: meter as MouthSource | null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    direction: (persona?: string): Direction => ({
      ...NEUTRAL,
      persona: persona ?? null,
      speaking: speaking.has(persona ?? "solo"),
    }),
    notify() {
      for (const listener of listeners) listener();
    },
  };
}

/** A model whose dispose is counted. */
function loadedModel(): LoadedModel & { disposed: () => number } {
  let disposed = 0;
  const model = {
    dispose: () => {
      disposed += 1;
    },
  } as unknown as AvatarModel;
  return {
    model,
    setup: {} as ResolvedSetup,
    box: { x: 0, y: 0, width: 100, height: 120 },
    outfit: null,
    disposed: () => disposed,
  };
}

/** Each member's load, settled by the test. */
function loads(reducedMotion = false) {
  const pending = new Map<
    string,
    { resolve: (loaded: LoadedModel | null) => void; reject: (error: unknown) => void }
  >();
  const how: StageLoad = {
    reducedMotion,
    load: (member) => new Promise((resolve, reject) => pending.set(member.id, { resolve, reject })),
  };
  return { how, pending };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CallStages", () => {
  test("makes a member's stage at once, and shows her model once it loads", async () => {
    const { parts, stages } = fakeParts();
    const signals = fakeSignals();
    const cast = new CallStages(signals, parts);
    const { how, pending } = loads(true);
    const before = cast.version();
    cast.load(soloTarget(member("milky-green")), how);
    expect(cast.get("milky-green")?.state).toBe("loading");
    expect(cast.get("milky-green")?.frames).toBe(0);
    expect(cast.version()).toBeGreaterThan(before);
    await settle();
    expect(stages[0]?.options.reducedMotion).toBe(true);
    const loading = cast.version();
    pending.get("milky-green")?.resolve(loadedModel());
    await settle();
    const stage = stages[0]!;
    expect(stage.calls).toEqual(["show", "frame", "wear", "mouth"]);
    expect(stage.source).toBe(cast.get("milky-green")?.tap);
    expect(cast.get("milky-green")?.state).toBe("ready");
    expect(cast.version()).toBeGreaterThan(loading);
  });

  test("disposes a call's stages, and routes the next call's", async () => {
    const { parts, canvases, stages } = fakeParts();
    const signals = fakeSignals();
    const cast = new CallStages(signals, parts);
    const first = loads();
    cast.load(soloTarget(member("milky-green")), first.how);
    await settle();
    first.pending.get("milky-green")?.resolve(loadedModel());
    await settle();

    cast.dispose();
    expect(stages[0]?.disposed).toBe(1);
    expect(canvases[0]?.removed).toBe(1);
    expect(cast.get("milky-green")).toBeUndefined();

    const second = loads();
    cast.load(chatTarget("c1", member("hazel"), null), second.how);
    await settle();
    second.pending.get("hazel")?.resolve(loadedModel());
    await settle();
    const stage = stages[1]!;
    const directed = stage.directed.length;
    const tap = cast.get("hazel")!.tap;
    tap.source = null;
    signals.notify();
    expect(stage.directed.length).toBe(directed + 1);
    expect(tap.source).toBe(signals.meter);
    expect(stages[0]?.directed.length).toBe(1);
  });

  test("gives the mouth only to the stage of whoever speaks on a group call", async () => {
    const { parts } = fakeParts();
    const signals = fakeSignals();
    const cast = new CallStages(signals, parts);
    const { how, pending } = loads();
    cast.load(chatTarget("c1", member("milky-green"), [member("hazel")]), how);
    await settle();
    pending.get("milky-green")?.resolve(loadedModel());
    pending.get("hazel")?.resolve(loadedModel());
    await settle();
    const taps = () => [cast.get("milky-green")?.tap.source, cast.get("hazel")?.tap.source];

    signals.speaking.add("hazel");
    signals.notify();
    expect(taps()).toEqual([null, signals.meter]);
    signals.speaking.delete("hazel");
    signals.speaking.add("milky-green");
    signals.notify();
    expect(taps()).toEqual([signals.meter, null]);
  });

  test("is blank once every stage made found no model or failed", async () => {
    const { parts } = fakeParts();
    const cast = new CallStages(fakeSignals(), parts);
    expect(cast.blank).toBe(false);

    const two = loads();
    cast.load(chatTarget("c1", member("milky-green"), [member("hazel")]), two.how);
    await settle();
    expect(cast.blank).toBe(false);
    two.pending.get("milky-green")?.resolve(null);
    await settle();
    expect(cast.get("milky-green")?.state).toBe("none");
    expect(cast.blank).toBe(false);
    two.pending.get("hazel")?.reject(new Error("no WebGL"));
    await settle();
    expect(cast.get("hazel")?.state).toBe("failed");
    expect(cast.blank).toBe(true);

    const three = loads();
    cast.load(
      chatTarget("c1", member("milky-green"), [
        member("hazel"),
        member("rose"),
        member("ash", null),
      ]),
      three.how,
    );
    await settle();
    expect(cast.get("ash")).toBeUndefined();
    three.pending.get("milky-green")?.resolve(null);
    three.pending.get("hazel")?.reject(new Error("trap"));
    three.pending.get("rose")?.resolve(loadedModel());
    await settle();
    expect(cast.blank).toBe(false);

    cast.load(soloTarget(member("ash", null)), loads().how);
    expect(cast.blank).toBe(false);
  });

  test("drops a model that loads after the call is over", async () => {
    const { parts, stages } = fakeParts();
    const cast = new CallStages(fakeSignals(), parts);
    const { how, pending } = loads();
    cast.load(soloTarget(member("milky-green")), how);
    await settle();
    const entry = cast.get("milky-green")!;
    const version = cast.version();
    cast.dispose();
    const late = loadedModel();
    pending.get("milky-green")?.resolve(late);
    await settle();
    expect(late.disposed()).toBe(1);
    expect(stages[0]?.calls).not.toContain("show");
    expect(entry.state).toBe("loading");
    expect(cast.version()).toBe(version + 1);
  });

  test("fails a stage whose model fails after it showed", async () => {
    const { parts, stages } = fakeParts();
    const cast = new CallStages(fakeSignals(), parts);
    const { how, pending } = loads();
    cast.load(soloTarget(member("milky-green")), how);
    await settle();
    pending.get("milky-green")?.resolve(loadedModel());
    await settle();
    expect(cast.get("milky-green")?.state).toBe("ready");
    stages[0]?.options.onError?.(new Error("lost") as never);
    expect(cast.get("milky-green")?.state).toBe("failed");
    expect(cast.blank).toBe(true);
  });
});
