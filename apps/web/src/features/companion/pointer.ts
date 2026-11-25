// The pointer over the desktop companion: whether she is under it, which decides whether her window
// takes clicks, and what a press on her is.
import type { ModelInventory } from "@/lib/api";
import { headAreaOf } from "@/lib/character-models";
import type { TapArea } from "./director";

/** Alpha above this is her (Phase 0's 24/255). */
export const HIT_ALPHA = 24 / 255;
/** A press that moves farther than this, in CSS px, is a drag. */
export const TAP_SLOP = 4;
/** The ring her picture keeps around it while she speaks, in CSS px. */
const PICTURE_RING = 4;

/** Whether she is under the pointer, from 1-pixel alpha reads: one at a time, the latest point next. */
export class HoverProbe {
  readonly #read: (x: number, y: number) => Promise<number>;
  readonly #changed: (over: boolean) => void;
  #over = false;
  #next: { readonly x: number; readonly y: number } | null = null;
  #reading = false;
  /** Bumped by leave(), so a read under way then counts for nothing. */
  #round = 0;

  constructor(read: (x: number, y: number) => Promise<number>, changed: (over: boolean) => void) {
    this.#read = read;
    this.#changed = changed;
  }

  move(x: number, y: number): void {
    this.#next = { x, y };
    if (!this.#reading) this.#readNext();
  }

  /** Not over, whatever a read under way answers: the pointer left her window, or what was under it went. */
  leave(): void {
    this.#next = null;
    this.#round += 1;
    this.#set(false);
  }

  get over(): boolean {
    return this.#over;
  }

  #readNext(): void {
    const point = this.#next;
    if (point === null) return;
    this.#next = null;
    this.#reading = true;
    const round = this.#round;
    this.#read(point.x, point.y)
      .catch(() => 0)
      .then((alpha) => {
        this.#reading = false;
        if (round === this.#round) this.#set(alpha > HIT_ALPHA);
        this.#readNext();
      });
  }

  #set(over: boolean): void {
    if (over === this.#over) return;
    this.#over = over;
    this.#changed(over);
  }
}

/** Whether (x, y) is on her round picture in a `side`-wide square window, inside its 4 px ring. */
export function onPicture(x: number, y: number, side: number): boolean {
  const centre = side / 2;
  return Math.hypot(x - centre, y - centre) <= centre - PICTURE_RING;
}

/** A press on her, in screen px: a tap, or past TAP_SLOP a drag. */
export class Press {
  /** Where it went down, which a drag starts from. */
  readonly start: { readonly x: number; readonly y: number };
  #dragging = false;

  constructor(x: number, y: number) {
    this.start = { x, y };
  }

  /** "drag-start" the first time it passes the slop, "drag" after, "none" before. */
  move(x: number, y: number): "none" | "drag-start" | "drag" {
    if (this.#dragging) return "drag";
    if (Math.hypot(x - this.start.x, y - this.start.y) <= TAP_SLOP) return "none";
    this.#dragging = true;
    return "drag-start";
  }

  get dragging(): boolean {
    return this.#dragging;
  }

  end(): "tap" | "drag-end" {
    return this.#dragging ? "drag-end" : "tap";
  }
}

/**
 * A tap's area: her head's hit area (`headAreaOf`) is "head", any other place on her "body"; on a
 * rig with no head hit area, a tap `nearHead` is "head".
 */
export function tapArea(
  hit: string | null,
  inventory: Pick<ModelInventory, "hitAreas">,
  nearHead: boolean,
): TapArea {
  const head = headAreaOf(inventory);
  if (head === null) return nearHead ? "head" : "body";
  return hit === head ? "head" : "body";
}
