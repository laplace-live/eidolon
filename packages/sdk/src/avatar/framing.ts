// Where her model sits in its element: boxes in the rig's canvas pixels (y down), and the player's
// view that shows one, a zoom over the canvas fitted into the element and a pan in CSS pixels.

/** A region of the rig's canvas by its edges, in its pixels (y down). */
export interface Bounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A region of the rig's canvas, in its pixels (y down). */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Zoom over the rig's canvas fitted into the element, and a pan in the element's CSS pixels. */
export interface View {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

/** The head's share of a bust's height, and how far down the bust its centre sits. */
const HEAD_SHARE = 0.42;
const HEAD_CENTRE = 0.4;
/** A bust's width over its height. */
const BUST_ASPECT = 0.8;
/** The margin a companion keeps around her, on each side, as a share of her size. */
const COMPANION_MARGIN = 0.04;

const WHOLE: View = { zoom: 1, x: 0, y: 0 };

/** A call's framing: her head and shoulders, or with no head to go by, the top third of her. */
export function bustBox(head: Bounds | null, character: Bounds): Box {
  if (head === null || !(head.y1 > head.y0)) {
    return {
      x: character.x0,
      y: character.y0,
      width: character.x1 - character.x0,
      height: (character.y1 - character.y0) / 3,
    };
  }
  const height = (head.y1 - head.y0) / HEAD_SHARE;
  const width = height * BUST_ASPECT;
  return {
    x: (head.x0 + head.x1) / 2 - width / 2,
    y: (head.y0 + head.y1) / 2 - height * HEAD_CENTRE,
    width,
    height,
  };
}

/** A companion's framing: all of her, with a little room around. */
export function companionBox(character: Bounds): Box {
  const width = character.x1 - character.x0;
  const height = character.y1 - character.y0;
  return {
    x: character.x0 - width * COMPANION_MARGIN,
    y: character.y0 - height * COMPANION_MARGIN,
    width: width * (1 + 2 * COMPANION_MARGIN),
    height: height * (1 + 2 * COMPANION_MARGIN),
  };
}

/** The view that shows all of `box`, centred, in an element of the given CSS size. */
export function viewFor(
  box: Box,
  rig: { readonly width: number; readonly height: number },
  element: { readonly width: number; readonly height: number },
): View {
  if (!(element.width > 0 && element.height > 0 && box.width > 0 && box.height > 0)) return WHOLE;
  if (!(rig.width > 0 && rig.height > 0)) return WHOLE;
  const fit = Math.min(element.width / rig.width, element.height / rig.height);
  const scale = Math.min(element.width / box.width, element.height / box.height);
  return {
    zoom: scale / fit,
    x: (rig.width / 2 - (box.x + box.width / 2)) * scale,
    y: (rig.height / 2 - (box.y + box.height / 2)) * scale,
  };
}

/**
 * `box` after a drag of the picture by (`dxCss`, `dyCss`) CSS pixels, at `scale` CSS pixels per rig
 * pixel: what was under the pointer stays under it.
 */
export function panBox(box: Box, dxCss: number, dyCss: number, scale: number): Box {
  if (!(scale > 0)) return box;
  return { ...box, x: box.x - dxCss / scale, y: box.y - dyCss / scale };
}

/** `box` zoomed in by `factor` (out below 1) about a point of the rig's canvas, which stays put. */
export function zoomBox(box: Box, factor: number, anchorRig: readonly [number, number]): Box {
  if (!(factor > 0)) return box;
  const [ax, ay] = anchorRig;
  return {
    x: ax - (ax - box.x) / factor,
    y: ay - (ay - box.y) / factor,
    width: box.width / factor,
    height: box.height / factor,
  };
}
