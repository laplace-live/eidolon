// Parameters the stage holds over her model's own motion: a mood's, faded in and out as PSD2Live
// fades its expressions.
import type { ParameterHold, ParameterSetting } from "./model.ts";

/**
 * Seconds a mood's parameters take to fade in or out: the half second PSD2Live's editor gives the
 * expressions it makes (ModelExpression.DEFAULT_FADE), eased as its runtime eases them.
 */
export const MOOD_FADE = 0.5;

function ease(x: number): number {
  return 0.5 - 0.5 * Math.cos(Math.min(Math.max(x, 0), 1) * Math.PI);
}

/** A parameter on its way from one value and weight to another. */
interface Fade {
  readonly fromValue: number;
  readonly fromWeight: number;
  readonly value: number;
  /** 1 while the mood holds it, 0 once it lets go. */
  readonly weight: number;
  /** Seconds since it set out. */
  time: number;
}

function shown(fade: Fade): { readonly value: number; readonly weight: number } {
  const e = ease(fade.time / MOOD_FADE);
  return {
    value: fade.fromValue + (fade.value - fade.fromValue) * e,
    weight: fade.fromWeight + (fade.weight - fade.fromWeight) * e,
  };
}

/**
 * A mood's parameters: each held one fades in, or to a new value, and each let go fades out, all
 * from wherever it is.
 */
export class MoodHolds {
  readonly #fades = new Map<string, Fade>();

  /** Holds `settings` and lets go of the rest; `now` skips the fades, as for a setup edited live. */
  set(settings: readonly ParameterSetting[], now: boolean): void {
    const wanted = new Map(settings.map(({ id, value }) => [id, value]));
    for (const [id, fade] of this.#fades) {
      if (wanted.has(id) || (fade.weight === 0 && !now)) continue;
      if (now) {
        this.#fades.delete(id);
        continue;
      }
      const at = shown(fade);
      this.#fades.set(id, {
        fromValue: at.value,
        fromWeight: at.weight,
        value: at.value,
        weight: 0,
        time: 0,
      });
    }
    for (const [id, value] of wanted) {
      const fade = this.#fades.get(id);
      if (now) {
        this.#fades.set(id, { fromValue: value, fromWeight: 1, value, weight: 1, time: MOOD_FADE });
        continue;
      }
      if (fade !== undefined && fade.value === value && fade.weight === 1) continue;
      const at = fade === undefined ? { value, weight: 0 } : shown(fade);
      this.#fades.set(id, {
        // Faded in from nothing, it comes in at its value rather than sliding to it.
        fromValue: at.weight > 0 ? at.value : value,
        fromWeight: at.weight,
        value,
        weight: 1,
        time: 0,
      });
    }
  }

  /** Steps the fades by `dt` seconds; what each parameter holds now. */
  step(dt: number): ParameterHold[] {
    const holds: ParameterHold[] = [];
    for (const [id, fade] of this.#fades) {
      fade.time += dt;
      if (fade.weight === 0 && fade.time >= MOOD_FADE) {
        this.#fades.delete(id);
        continue;
      }
      const { value, weight } = shown(fade);
      if (weight > 0) holds.push({ id, value, weight });
    }
    return holds;
  }
}
