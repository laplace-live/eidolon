// Where the desktop companion's eyes are in her window, where she looks to meet the cursor, and
// how near them a tap is on her head.
import type { Bounds, Box } from "@laplace.live/eidolon-sdk/avatar";
import type { CompanionCursor, WindowSize } from "@/lib/desktop";

/** How far from her eyes, in CSS px, the cursor turns her about three quarters of the way. */
export const GAZE_REACH = 400;
/** A cursor still this long, in ms, hands her eyes back to their own wandering. */
export const CURSOR_REST_MS = 4_000;
/**
 * How near her eyes a point is on her head, as a share of her framing's drawn width. On a
 * full-length model converted from Live2D, with no head hit area, a quarter of it around the
 * estimate a sixth of the way down took in her face and all but the top of her hair, with her neck
 * and collar.
 */
export const HEAD_REACH = 0.25;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** CSS px per rig px where the stage fits `box` into `element`. */
function scaleOf(box: Box, element: WindowSize): number {
  return Math.min(element.width / box.width, element.height / box.height);
}

/** Her head's centre in her window, in CSS px, through her framing as the stage fits it; a sixth of the way down without one. */
export function eyePoint(head: Bounds | null, box: Box, element: WindowSize): Point {
  const scale = scaleOf(box, element);
  const rig =
    head === null
      ? { x: box.x + box.width / 2, y: box.y + box.height / 6 }
      : { x: (head.x0 + head.x1) / 2, y: (head.y0 + head.y1) / 2 };
  return {
    x: element.width / 2 + (rig.x - (box.x + box.width / 2)) * scale,
    y: element.height / 2 + (rig.y - (box.y + box.height / 2)) * scale,
  };
}

/** Whether `point` of her window is within HEAD_REACH of her framing's drawn width of her eyes. */
export function nearHead(
  point: Point,
  head: Bounds | null,
  box: Box,
  element: WindowSize,
): boolean {
  const eye = eyePoint(head, box, element);
  const reach = HEAD_REACH * box.width * scaleOf(box, element);
  return Math.hypot(point.x - eye.x, point.y - eye.y) <= reach;
}

/** Her gaze toward the cursor, each axis -1..1, y up: tanh of the distance over `reach`. */
export function gazeToward(
  cursor: CompanionCursor,
  eye: Point,
  reach = GAZE_REACH,
): readonly [number, number] {
  return [Math.tanh((cursor.x - eye.x) / reach), Math.tanh((eye.y - cursor.y) / reach)];
}
