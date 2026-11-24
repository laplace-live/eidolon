import { describe, expect, test, vi } from "vitest";
import type { ModelInventory } from "@/lib/api";
import { HIT_ALPHA, HoverProbe, onPicture, Press, TAP_SLOP, tapArea } from "./pointer";

/** A read the test answers by hand. */
function handReads() {
  const calls: {
    readonly x: number;
    readonly y: number;
    readonly answer: (alpha: number) => void;
    readonly fail: () => void;
  }[] = [];
  const read = (x: number, y: number) =>
    new Promise<number>((answer, reject) => {
      calls.push({ x, y, answer, fail: () => reject(new Error("gone")) });
    });
  return { calls, read };
}

/** Lets the probe's chain on an answered read run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("HoverProbe", () => {
  test("reads one point at a time: three moves during a read cost one more, at the last", async () => {
    const { calls, read } = handReads();
    const probe = new HoverProbe(read, vi.fn());
    probe.move(1, 1);
    probe.move(2, 2);
    probe.move(3, 3);
    probe.move(4, 4);
    expect(calls.map(({ x, y }) => [x, y])).toEqual([[1, 1]]);
    calls[0]?.answer(0);
    await settled();
    expect(calls.map(({ x, y }) => [x, y])).toEqual([
      [1, 1],
      [4, 4],
    ]);
    calls[1]?.answer(0);
    await settled();
    expect(calls).toHaveLength(2);
  });

  test("calls changed only when she comes under the pointer or leaves it", async () => {
    const { calls, read } = handReads();
    const changed = vi.fn();
    const probe = new HoverProbe(read, changed);
    for (const alpha of [0.5, 0.05, 0.6, 0.6]) {
      probe.move(10, 10);
      calls.at(-1)?.answer(alpha);
      await settled();
    }
    expect(changed.mock.calls).toEqual([[true], [false], [true]]);
    expect(probe.over).toBe(true);
    expect(HIT_ALPHA).toBeCloseTo(24 / 255);
  });

  test("a read that fails is no alpha", async () => {
    const { calls, read } = handReads();
    const changed = vi.fn();
    const probe = new HoverProbe(read, changed);
    probe.move(1, 1);
    calls[0]?.answer(1);
    await settled();
    probe.move(2, 2);
    calls[1]?.fail();
    await settled();
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  test("leave() while over says so once, and a read under way then counts for nothing", async () => {
    const { calls, read } = handReads();
    const changed = vi.fn();
    const probe = new HoverProbe(read, changed);
    probe.move(1, 1);
    calls[0]?.answer(1);
    await settled();
    probe.leave();
    probe.leave();
    expect(changed.mock.calls).toEqual([[true], [false]]);

    probe.move(2, 2);
    probe.leave();
    calls[1]?.answer(1);
    await settled();
    expect(probe.over).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    // The point kept during the read went with the leave: nothing more is read.
    expect(calls).toHaveLength(2);

    // A move after the leave reads again once the read under way is done.
    probe.move(3, 3);
    probe.leave();
    probe.move(4, 4);
    calls[2]?.answer(0);
    await settled();
    expect(calls.map(({ x, y }) => [x, y]).at(-1)).toEqual([4, 4]);
    calls[3]?.answer(1);
    await settled();
    expect(probe.over).toBe(true);
  });
});

describe("onPicture", () => {
  test("her round picture, inside the ring around it", () => {
    expect(onPicture(64, 64, 128)).toBe(true);
    expect(onPicture(64, 6, 128)).toBe(true);
    expect(onPicture(64, 2, 128)).toBe(false);
    expect(onPicture(126, 64, 128)).toBe(false);
    expect(onPicture(8, 8, 128)).toBe(false);
  });
});

describe("Press", () => {
  test("within the slop it is a tap", () => {
    const press = new Press(100, 100);
    expect(press.move(102, 102)).toBe("none");
    expect(press.move(100, 100 + TAP_SLOP)).toBe("none");
    expect(press.dragging).toBe(false);
    expect(press.end()).toBe("tap");
  });

  test("past it a drag starts once, from where it went down", () => {
    const press = new Press(100, 100);
    expect(press.move(103, 103)).toBe("drag-start");
    expect(press.dragging).toBe(true);
    expect(press.move(100, 100)).toBe("drag");
    expect(press.move(140, 60)).toBe("drag");
    expect(press.start).toEqual({ x: 100, y: 100 });
    expect(press.end()).toBe("drag-end");
  });
});

describe("tapArea", () => {
  const inventory: Pick<ModelInventory, "hitAreas"> = {
    hitAreas: [
      { id: "HitAreaHead", name: "头部" },
      { id: "HitAreaBody", name: "身体" },
    ],
  };

  test("her head's hit area is her head; anywhere else on her, her body", () => {
    expect(tapArea("HitAreaHead", inventory)).toBe("head");
    expect(tapArea("HitAreaBody", inventory)).toBe("body");
    expect(tapArea(null, inventory)).toBe("body");
    expect(tapArea(null, { hitAreas: [] })).toBe("body");
  });
});
