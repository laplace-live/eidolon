// Motion settings for stages shown side by side so members don't breathe, idle, look away or nod in
// unison.

/** How a stage's idle, breathing, gaze and reactions differ in pace and phase from another's. */
export interface AvatarStageMotion {
  /** Speed multiplier for clips, breathing, blinks, gaze and head gestures; 1 unless given. */
  readonly pace?: number;
  /** Seconds into her idle clip and breathing cycle she starts at; 0 unless given. */
  readonly offset?: number;
  /** Breathing sway strength, where 1 is the runtime's default. */
  readonly sway?: number;
  /** Where she looks while thinking, each axis -1..1 (x right, y up); [0.35, 0.45] unless given. */
  readonly away?: readonly [number, number];
  /** Seconds before a non-speaking direction gesture starts; 0 unless given. */
  readonly reaction?: number;
}

export const AWAY: readonly [number, number] = [0.35, 0.45];

const PACE_RANGE: readonly [number, number] = [0.82, 1.18];
const SWAY_RANGE: readonly [number, number] = [0.82, 1.18];
// Matches PSD2Live's 12 s Idle loop while staying inside its 15.535 s BodyAngleX breath period,
// so a pair separated around 12 s starts well apart on both.
const OFFSET_SPAN = 12;
const AWAY_X_RANGE: readonly [number, number] = [0.28, 0.42];
const AWAY_Y_RANGE: readonly [number, number] = [0.36, 0.52];
const REACTION_SPAN = 0.24;

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.min(Math.floor(random() * (i + 1)), i);
    const picked = items[j];
    const current = items[i];
    if (picked !== undefined && current !== undefined) {
      items[i] = picked;
      items[j] = current;
    }
  }
  return items;
}

function spread(
  count: number,
  lo: number,
  hi: number,
  random: () => number,
  wrap = false,
): number[] {
  if (count === 1 && !wrap) return [lo + (0.2 + 0.6 * random()) * (hi - lo)];
  const base = wrap ? random() : 0;
  const values = Array.from({ length: count }, (_, i) => {
    const slot = (i + 0.15 + 0.7 * random()) / count;
    const u = wrap ? (base + slot) % 1 : slot;
    return lo + u * (hi - lo);
  });
  return shuffle(values, random);
}

/**
 * Distinct motion settings for `count` stages shown together, stratified and shuffled so no two
 * share the same pace, breathing/idle phase, sway, thinking gaze side, or listener reaction time.
 */
export function stageMotions(
  count: number,
  random: () => number = Math.random,
): AvatarStageMotion[] {
  if (!(count > 0)) return [];
  const n = Math.floor(count);
  const paces = spread(n, PACE_RANGE[0], PACE_RANGE[1], random);
  const offsets = spread(n, 0, OFFSET_SPAN, random, true);
  const sways = spread(n, SWAY_RANGE[0], SWAY_RANGE[1], random);
  const firstSign = random() < 0.5 ? 1 : -1;
  const signs = shuffle(
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? firstSign : -firstSign)),
    random,
  );
  const awayXs = spread(n, AWAY_X_RANGE[0], AWAY_X_RANGE[1], random);
  const awayYs = spread(n, AWAY_Y_RANGE[0], AWAY_Y_RANGE[1], random);
  const reactions =
    n === 1
      ? [0]
      : shuffle(
          Array.from({ length: n }, (_, i) =>
            i === 0
              ? 0.04 * random()
              : 0.06 + ((i - 1 + 0.15 + 0.7 * random()) / (n - 1)) * (REACTION_SPAN - 0.06),
          ),
          random,
        );
  return Array.from({ length: n }, (_, i) => ({
    pace: paces[i] ?? 1,
    offset: offsets[i] ?? 0,
    sway: sways[i] ?? 1,
    away: [(signs[i] ?? 1) * (awayXs[i] ?? AWAY[0]), awayYs[i] ?? AWAY[1]] as const,
    reaction: reactions[i] ?? 0,
  }));
}
