import { describe, expect, test } from "vitest";
import { eyePoint, GAZE_REACH, gazeToward } from "./gaze";

describe("gazeToward", () => {
  const eye = { x: 120, y: 80 };

  test("the cursor on her eyes is straight ahead", () => {
    expect(gazeToward(eye, eye)).toEqual([0, 0]);
  });

  test("its reach to the right turns her about three quarters of the way", () => {
    const [x, y] = gazeToward({ x: eye.x + GAZE_REACH, y: eye.y }, eye);
    expect(x).toBeCloseTo(Math.tanh(1));
    expect(y).toBeCloseTo(0);
  });

  test("far above her is y up, near 1; below and to the left, both negative", () => {
    const [, up] = gazeToward({ x: eye.x, y: eye.y - 5_000 }, eye);
    expect(up).toBeGreaterThan(0.99);
    const [left, down] = gazeToward({ x: eye.x - 200, y: eye.y + 200 }, eye);
    expect(left).toBeCloseTo(-Math.tanh(0.5));
    expect(down).toBeCloseTo(-Math.tanh(0.5));
  });
});

describe("eyePoint", () => {
  test("a head centred in a box that fills the window is the window's centre", () => {
    const box = { x: 100, y: 200, width: 400, height: 800 };
    const head = { x0: 250, y0: 550, x1: 350, y1: 650 };
    expect(eyePoint(head, box, { width: 200, height: 400 })).toEqual({ x: 100, y: 200 });
  });

  test("a head is placed through the box's scale and offset", () => {
    const box = { x: 100, y: 200, width: 400, height: 800 };
    const head = { x0: 260, y0: 260, x1: 340, y1: 340 };
    // Half scale: the head's centre (300, 300) is 0 across and 300 up from the box's (300, 600).
    expect(eyePoint(head, box, { width: 200, height: 400 })).toEqual({ x: 100, y: 50 });
  });

  test("a box letterboxed in a wider window keeps her centred across", () => {
    const box = { x: 0, y: 0, width: 400, height: 800 };
    const head = { x0: 150, y0: 100, x1: 250, y1: 200 };
    // The box's height fits, at half scale; the window is 100 px wider than the box drawn in it.
    expect(eyePoint(head, box, { width: 300, height: 400 })).toEqual({ x: 150, y: 75 });
  });

  test("with no head, a sixth of the way down, centred", () => {
    const box = { x: 50, y: 0, width: 300, height: 600 };
    expect(eyePoint(null, box, { width: 150, height: 300 })).toEqual({ x: 75, y: 50 });
  });
});
