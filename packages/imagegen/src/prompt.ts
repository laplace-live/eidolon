import { personaTimeZone, zonedClock } from "@eidolon/config";

export interface PersonaClock {
  readonly hour: number;
  readonly minute: number;
}

/** The wall clock in PERSONA_TIMEZONE, read fresh on every call. */
export function personaClock(at?: Date): PersonaClock {
  return zonedClock(personaTimeZone(), at);
}

export const SELFIE_PROMPT = `Turn the reference character into a casual selfie, drawn in classic 2D anime
style.

Keep unchanged: the character's face, hairstyle, hair color, eye color, and
outfit design. The result has to read as the same character, not a lookalike.
{company}
Framing: a phone selfie held at arm's length — camera slightly above eye
level, head and shoulders filling the frame, eyes on the lens, relaxed
natural smile.

Render: hand-drawn 2D anime, the look of a traditional cel animation frame.
Crisp inked outlines of varying weight, flat color fills, hard-edged two-tone
cel shading, glossy block highlights in the hair, classic anime eyes. No 3D,
no photorealism, no physically based materials, no rendered textures.

Time: it is {time}. The light, the shadows, and the sky have to read as that
hour.

Light: {light}, drawn as simple cel shadow shapes from one clear direction,
over {setting}.

No text, watermarks, logos, UI overlays, or anyone beyond the people
described above.
`;

export const INDOORS = "a softly painted, uncluttered indoor background";
export const OUTDOORS =
  "a softly painted outdoor background in virtual Shanghai — a street, a park," +
  " a coffee shop, wherever the group would be";

const SOLO =
  "\nExactly one person is in the picture: the character in the" +
  " single reference image. No second version of her, no one else.\n";

function group(friends: readonly string[]): string {
  return (
    "\nAlso in frame: " +
    friends.join(", ") +
    `. Exactly ${friends.length + 1} people are in the picture — one` +
    " per reference image, and nobody else. The references map in" +
    " order: the first is the main character, each one after it is the" +
    " next friend named above. Draw one character per reference image;" +
    " never turn a single reference into two characters. Match each" +
    " friend's face, hair, and outfit as closely as the main" +
    " character's. It's a group selfie taken while out together:" +
    " everyone leaning into one phone camera, the main character" +
    " nearest the lens holding it.\n"
  );
}

export interface AmbienceRow {
  /** The first local hour the row covers. */
  readonly start: number;
  readonly label: string;
  readonly indoor: string;
  readonly outdoor: string;
}

// Ordered; hours before the first boundary wrap back to the last row.
export const AMBIENCE: readonly AmbienceRow[] = [
  {
    start: 5,
    label: "early morning",
    indoor: "cool pale sunrise light slanting in through the window",
    outdoor: "cool pale sunrise light and long thin shadows down the street",
  },
  {
    start: 9,
    label: "mid-morning",
    indoor: "bright clear daylight filling the room",
    outdoor: "bright clear morning sun under an open blue sky",
  },
  {
    start: 12,
    label: "midday",
    indoor: "strong overhead sun, crisp shadows, curtains half-drawn",
    outdoor: "strong overhead sun, short hard shadows, a washed-out bright sky",
  },
  {
    start: 15,
    label: "late afternoon",
    indoor: "warm low golden sunlight and long soft shadows",
    outdoor: "warm low golden sunlight raking across everything, long shadows",
  },
  {
    start: 18,
    label: "dusk",
    indoor: "orange-pink sunset through the window, a lamp just switched on",
    outdoor: "an orange-pink sunset sky, shopfront lights just coming on",
  },
  {
    start: 21,
    label: "night",
    indoor: "warm indoor lamplight against a fully dark window",
    outdoor: "a fully dark sky, everyone lit by warm street and storefront light",
  },
  {
    start: 23,
    label: "late night",
    indoor: "a dim room lit mostly by the cool glow of a nearby screen",
    outdoor: "a quiet dark street under sparse cool streetlight and neon",
  },
];

// The hours AMBIENCE draws without daylight, which is also when the persona wears her night outfit.
export const AFTER_DARK: ReadonlySet<string> = new Set(["night", "late night"]);

export function ambience(hour: number): AmbienceRow {
  let row = AMBIENCE[AMBIENCE.length - 1];
  for (const candidate of AMBIENCE) if (hour >= candidate.start) row = candidate;
  return row;
}

// Not String#replaceAll: a friend's file name could carry its `$&`-style replacement patterns.
function replaceAll(text: string, slot: string, value: string): string {
  return text.split(slot).join(value);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * `template`'s {time} and {light} slots, resolved against the persona's clock. The bot answers
 * viewers live, so its selfie should match the hour they are actually watching at — in the
 * persona's timezone, not the machine's. Plain substitution, never a template engine, so a brace
 * in an edited prompt can't break it.
 */
export function fillTime(
  template: string,
  options: { readonly outdoors?: boolean; readonly clock?: PersonaClock } = {},
): string {
  const clock = options.clock ?? personaClock();
  const row = ambience(clock.hour);
  const time = `${row.label}, about ${pad2(clock.hour)}:${pad2(clock.minute)} local time`;
  return replaceAll(
    replaceAll(template, "{time}", time),
    "{light}",
    options.outdoors ? row.outdoor : row.indoor,
  );
}

/**
 * The built-in prompt for one selfie, alone indoors or out with `friends`. A group selfie in the
 * persona's room would read as odd, so naming anyone moves the scene outdoors and switches the
 * hour's lighting to match.
 */
export function buildSelfiePrompt(friends: readonly string[], clock?: PersonaClock): string {
  const out = friends.length > 0;
  const filled = replaceAll(
    replaceAll(SELFIE_PROMPT, "{company}", out ? group(friends) : SOLO),
    "{setting}",
    out ? OUTDOORS : INDOORS,
  );
  return fillTime(filled, { outdoors: out, clock });
}
