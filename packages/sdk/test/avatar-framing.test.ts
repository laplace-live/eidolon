import { describe, expect, test } from "vitest";
import {
  type Box,
  bustBox,
  companionBox,
  panBox,
  type View,
  viewFor,
  zoomBox,
} from "../src/avatar/framing.ts";

/** tml's Head hit area and all of her as the rig loads, rounded. */
const HEAD = { x0: 869, y0: 175, x1: 1177, y1: 517 };
const CHARACTER = { x0: 600, y0: 46, x1: 1439, y1: 2009 };
const RIG = { width: 2048, height: 2048 };

/** Where a point of the rig's canvas lands in the element, as the player lays the view out. */
function place(
  view: View,
  element: { readonly width: number; readonly height: number },
  [x, y]: readonly [number, number],
): [number, number] {
  const scale = Math.min(element.width / RIG.width, element.height / RIG.height) * view.zoom;
  const left = element.width / 2 + view.x - (RIG.width / 2) * scale;
  const top = element.height / 2 + view.y - (RIG.height / 2) * scale;
  return [x * scale + left, y * scale + top];
}

function corners(box: Box): [readonly [number, number], readonly [number, number]] {
  return [
    [box.x, box.y],
    [box.x + box.width, box.y + box.height],
  ];
}

describe("bustBox", () => {
  test("gives her head 42% of the height, its centre 40% down, at 4:5", () => {
    const box = bustBox(HEAD, CHARACTER);
    const head = HEAD.y1 - HEAD.y0;
    expect(box.height).toBeCloseTo(head / 0.42);
    expect(box.width).toBeCloseTo(box.height * 0.8);
    expect(box.x + box.width / 2).toBeCloseTo((HEAD.x0 + HEAD.x1) / 2);
    expect(box.y + box.height * 0.4).toBeCloseTo((HEAD.y0 + HEAD.y1) / 2);
  });

  test("without a head, frames the top third of her", () => {
    expect(bustBox(null, CHARACTER)).toEqual({
      x: 600,
      y: 46,
      width: 839,
      height: (2009 - 46) / 3,
    });
  });
});

test("companionBox keeps 4% of her size around her on each side", () => {
  const box = companionBox({ x0: 100, y0: 0, x1: 200, y1: 1000 });
  expect(box.x).toBeCloseTo(96);
  expect(box.y).toBeCloseTo(-40);
  expect(box.width).toBeCloseTo(108);
  expect(box.height).toBeCloseTo(1080);
});

describe("viewFor", () => {
  test("shows all of the box, centred, in wide and tall elements alike", () => {
    const box = bustBox(HEAD, CHARACTER);
    for (const element of [
      { width: 800, height: 500 },
      { width: 300, height: 600 },
    ]) {
      const view = viewFor(box, RIG, element);
      const [[x0, y0], [x1, y1]] = corners(box).map((corner) => place(view, element, corner)) as [
        [number, number],
        [number, number],
      ];
      expect((x0 + x1) / 2).toBeCloseTo(element.width / 2);
      expect((y0 + y1) / 2).toBeCloseTo(element.height / 2);
      // Contained: it fills one side exactly and fits inside the other.
      const fills = [x1 - x0 - element.width, y1 - y0 - element.height];
      expect(Math.max(...fills)).toBeCloseTo(0);
      expect(Math.min(...fills)).toBeLessThanOrEqual(1e-9);
    }
  });

  test("the whole canvas is the player's own view", () => {
    expect(viewFor({ x: 0, y: 0, ...RIG }, RIG, { width: 640, height: 480 })).toEqual({
      zoom: 1,
      x: 0,
      y: 0,
    });
  });

  test("an empty element or box leaves the view alone", () => {
    expect(viewFor({ x: 0, y: 0, width: 10, height: 10 }, RIG, { width: 0, height: 480 })).toEqual({
      zoom: 1,
      x: 0,
      y: 0,
    });
    expect(viewFor({ x: 5, y: 5, width: 0, height: 10 }, RIG, { width: 640, height: 480 })).toEqual(
      { zoom: 1, x: 0, y: 0 },
    );
  });
});

describe("editing a framing", () => {
  test("panBox keeps what was under the pointer under it", () => {
    const element = { width: 800, height: 500 };
    const box = bustBox(HEAD, CHARACTER);
    const view = viewFor(box, RIG, element);
    const scale = Math.min(element.width / RIG.width, element.height / RIG.height) * view.zoom;
    const point = [1000, 300] as const;
    const [px, py] = place(view, element, point);
    const moved = panBox(box, 40, -25, scale);
    const [qx, qy] = place(viewFor(moved, RIG, element), element, point);
    expect(qx - px).toBeCloseTo(40);
    expect(qy - py).toBeCloseTo(-25);
    expect(panBox(box, 10, 10, 0)).toBe(box);
  });

  test("zoomBox scales about its anchor, which stays put", () => {
    const box = { x: 100, y: 200, width: 400, height: 600 };
    const zoomed = zoomBox(box, 2, [300, 500]);
    expect(zoomed).toEqual({ x: 200, y: 350, width: 200, height: 300 });
    expect(zoomBox(zoomed, 0.5, [300, 500])).toEqual(box);
    expect(zoomBox(box, 0, [0, 0])).toBe(box);
  });
});
