// Selfie prompts, reference choices and encodings at fixed clocks and inputs, so a drift in any
// of them fails a test.

export const PROMPT_SOLO_0905 =
  "Turn the reference character into a casual selfie, drawn in classic 2D anime\nstyle.\n\nKeep unchanged: the character's face, hairstyle, hair color, eye color, and\noutfit design. The result has to read as the same character, not a lookalike.\n\nExactly one person is in the picture: the character in the single reference image. No second version of her, no one else.\n\nFraming: a phone selfie held at arm's length — camera slightly above eye\nlevel, head and shoulders filling the frame, eyes on the lens, relaxed\nnatural smile.\n\nRender: hand-drawn 2D anime, the look of a traditional cel animation frame.\nCrisp inked outlines of varying weight, flat color fills, hard-edged two-tone\ncel shading, glossy block highlights in the hair, classic anime eyes. No 3D,\nno photorealism, no physically based materials, no rendered textures.\n\nTime: it is mid-morning, about 09:05 local time. The light, the shadows, and the sky have to read as that\nhour.\n\nLight: bright clear daylight filling the room, drawn as simple cel shadow shapes from one clear direction,\nover a softly painted, uncluttered indoor background.\n\nNo text, watermarks, logos, UI overlays, or anyone beyond the people\ndescribed above.\n";

export const PROMPT_GROUP_2230 =
  "Turn the reference character into a casual selfie, drawn in classic 2D anime\nstyle.\n\nKeep unchanged: the character's face, hairstyle, hair color, eye color, and\noutfit design. The result has to read as the same character, not a lookalike.\n\nAlso in frame: 七海Nana7mi. Exactly 2 people are in the picture — one per reference image, and nobody else. The references map in order: the first is the main character, each one after it is the next friend named above. Draw one character per reference image; never turn a single reference into two characters. Match each friend's face, hair, and outfit as closely as the main character's. It's a group selfie taken while out together: everyone leaning into one phone camera, the main character nearest the lens holding it.\n\nFraming: a phone selfie held at arm's length — camera slightly above eye\nlevel, head and shoulders filling the frame, eyes on the lens, relaxed\nnatural smile.\n\nRender: hand-drawn 2D anime, the look of a traditional cel animation frame.\nCrisp inked outlines of varying weight, flat color fills, hard-edged two-tone\ncel shading, glossy block highlights in the hair, classic anime eyes. No 3D,\nno photorealism, no physically based materials, no rendered textures.\n\nTime: it is night, about 22:30 local time. The light, the shadows, and the sky have to read as that\nhour.\n\nLight: a fully dark sky, everyone lit by warm street and storefront light, drawn as simple cel shadow shapes from one clear direction,\nover a softly painted outdoor background in virtual Shanghai — a street, a park, a coffee shop, wherever the group would be.\n\nNo text, watermarks, logos, UI overlays, or anyone beyond the people\ndescribed above.\n";

export const PROMPT_DUPLICATES_0000 =
  "Turn the reference character into a casual selfie, drawn in classic 2D anime\nstyle.\n\nKeep unchanged: the character's face, hairstyle, hair color, eye color, and\noutfit design. The result has to read as the same character, not a lookalike.\n\nAlso in frame: A, A. Exactly 3 people are in the picture — one per reference image, and nobody else. The references map in order: the first is the main character, each one after it is the next friend named above. Draw one character per reference image; never turn a single reference into two characters. Match each friend's face, hair, and outfit as closely as the main character's. It's a group selfie taken while out together: everyone leaning into one phone camera, the main character nearest the lens holding it.\n\nFraming: a phone selfie held at arm's length — camera slightly above eye\nlevel, head and shoulders filling the frame, eyes on the lens, relaxed\nnatural smile.\n\nRender: hand-drawn 2D anime, the look of a traditional cel animation frame.\nCrisp inked outlines of varying weight, flat color fills, hard-edged two-tone\ncel shading, glossy block highlights in the hair, classic anime eyes. No 3D,\nno photorealism, no physically based materials, no rendered textures.\n\nTime: it is late night, about 00:00 local time. The light, the shadows, and the sky have to read as that\nhour.\n\nLight: a quiet dark street under sparse cool streetlight and neon, drawn as simple cel shadow shapes from one clear direction,\nover a softly painted outdoor background in virtual Shanghai — a street, a park, a coffee shop, wherever the group would be.\n\nNo text, watermarks, logos, UI overlays, or anyone beyond the people\ndescribed above.\n";

export const SELFIE_PROMPT_TEXT =
  "Turn the reference character into a casual selfie, drawn in classic 2D anime\nstyle.\n\nKeep unchanged: the character's face, hairstyle, hair color, eye color, and\noutfit design. The result has to read as the same character, not a lookalike.\n{company}\nFraming: a phone selfie held at arm's length — camera slightly above eye\nlevel, head and shoulders filling the frame, eyes on the lens, relaxed\nnatural smile.\n\nRender: hand-drawn 2D anime, the look of a traditional cel animation frame.\nCrisp inked outlines of varying weight, flat color fills, hard-edged two-tone\ncel shading, glossy block highlights in the hair, classic anime eyes. No 3D,\nno photorealism, no physically based materials, no rendered textures.\n\nTime: it is {time}. The light, the shadows, and the sky have to read as that\nhour.\n\nLight: {light}, drawn as simple cel shadow shapes from one clear direction,\nover {setting}.\n\nNo text, watermarks, logos, UI overlays, or anyone beyond the people\ndescribed above.\n";

export const INDOORS_TEXT = "a softly painted, uncluttered indoor background";

export const OUTDOORS_TEXT =
  "a softly painted outdoor background in virtual Shanghai — a street, a park, a coffee shop, wherever the group would be";

/** [start, label, indoor, outdoor] */
export const AMBIENCE_ROWS: [number, string, string, string][] = [
  [
    5,
    "early morning",
    "cool pale sunrise light slanting in through the window",
    "cool pale sunrise light and long thin shadows down the street",
  ],
  [
    9,
    "mid-morning",
    "bright clear daylight filling the room",
    "bright clear morning sun under an open blue sky",
  ],
  [
    12,
    "midday",
    "strong overhead sun, crisp shadows, curtains half-drawn",
    "strong overhead sun, short hard shadows, a washed-out bright sky",
  ],
  [
    15,
    "late afternoon",
    "warm low golden sunlight and long soft shadows",
    "warm low golden sunlight raking across everything, long shadows",
  ],
  [
    18,
    "dusk",
    "orange-pink sunset through the window, a lamp just switched on",
    "an orange-pink sunset sky, shopfront lights just coming on",
  ],
  [
    21,
    "night",
    "warm indoor lamplight against a fully dark window",
    "a fully dark sky, everyone lit by warm street and storefront light",
  ],
  [
    23,
    "late night",
    "a dim room lit mostly by the cool glow of a nearby screen",
    "a quiet dark street under sparse cool streetlight and neon",
  ],
];

/** hour → label */
export const AMBIENCE_LABELS: Record<string, string> = {
  "0": "late night",
  "1": "late night",
  "2": "late night",
  "3": "late night",
  "4": "late night",
  "5": "early morning",
  "6": "early morning",
  "7": "early morning",
  "8": "early morning",
  "9": "mid-morning",
  "10": "mid-morning",
  "11": "mid-morning",
  "12": "midday",
  "13": "midday",
  "14": "midday",
  "15": "late afternoon",
  "16": "late afternoon",
  "17": "late afternoon",
  "18": "dusk",
  "19": "dusk",
  "20": "dusk",
  "21": "night",
  "22": "night",
  "23": "late night",
};

/** hour → [fillTime("{time}|{light}|{x}{time}") at :07, the same outdoors with "{time}|{light}"] */
export const FILL_TIME_07: Record<string, [string, string]> = {
  "0": [
    "late night, about 00:07 local time|a dim room lit mostly by the cool glow of a nearby screen|{x}late night, about 00:07 local time",
    "late night, about 00:07 local time|a quiet dark street under sparse cool streetlight and neon",
  ],
  "1": [
    "late night, about 01:07 local time|a dim room lit mostly by the cool glow of a nearby screen|{x}late night, about 01:07 local time",
    "late night, about 01:07 local time|a quiet dark street under sparse cool streetlight and neon",
  ],
  "2": [
    "late night, about 02:07 local time|a dim room lit mostly by the cool glow of a nearby screen|{x}late night, about 02:07 local time",
    "late night, about 02:07 local time|a quiet dark street under sparse cool streetlight and neon",
  ],
  "3": [
    "late night, about 03:07 local time|a dim room lit mostly by the cool glow of a nearby screen|{x}late night, about 03:07 local time",
    "late night, about 03:07 local time|a quiet dark street under sparse cool streetlight and neon",
  ],
  "4": [
    "late night, about 04:07 local time|a dim room lit mostly by the cool glow of a nearby screen|{x}late night, about 04:07 local time",
    "late night, about 04:07 local time|a quiet dark street under sparse cool streetlight and neon",
  ],
  "5": [
    "early morning, about 05:07 local time|cool pale sunrise light slanting in through the window|{x}early morning, about 05:07 local time",
    "early morning, about 05:07 local time|cool pale sunrise light and long thin shadows down the street",
  ],
  "6": [
    "early morning, about 06:07 local time|cool pale sunrise light slanting in through the window|{x}early morning, about 06:07 local time",
    "early morning, about 06:07 local time|cool pale sunrise light and long thin shadows down the street",
  ],
  "7": [
    "early morning, about 07:07 local time|cool pale sunrise light slanting in through the window|{x}early morning, about 07:07 local time",
    "early morning, about 07:07 local time|cool pale sunrise light and long thin shadows down the street",
  ],
  "8": [
    "early morning, about 08:07 local time|cool pale sunrise light slanting in through the window|{x}early morning, about 08:07 local time",
    "early morning, about 08:07 local time|cool pale sunrise light and long thin shadows down the street",
  ],
  "9": [
    "mid-morning, about 09:07 local time|bright clear daylight filling the room|{x}mid-morning, about 09:07 local time",
    "mid-morning, about 09:07 local time|bright clear morning sun under an open blue sky",
  ],
  "10": [
    "mid-morning, about 10:07 local time|bright clear daylight filling the room|{x}mid-morning, about 10:07 local time",
    "mid-morning, about 10:07 local time|bright clear morning sun under an open blue sky",
  ],
  "11": [
    "mid-morning, about 11:07 local time|bright clear daylight filling the room|{x}mid-morning, about 11:07 local time",
    "mid-morning, about 11:07 local time|bright clear morning sun under an open blue sky",
  ],
  "12": [
    "midday, about 12:07 local time|strong overhead sun, crisp shadows, curtains half-drawn|{x}midday, about 12:07 local time",
    "midday, about 12:07 local time|strong overhead sun, short hard shadows, a washed-out bright sky",
  ],
  "13": [
    "midday, about 13:07 local time|strong overhead sun, crisp shadows, curtains half-drawn|{x}midday, about 13:07 local time",
    "midday, about 13:07 local time|strong overhead sun, short hard shadows, a washed-out bright sky",
  ],
  "14": [
    "midday, about 14:07 local time|strong overhead sun, crisp shadows, curtains half-drawn|{x}midday, about 14:07 local time",
    "midday, about 14:07 local time|strong overhead sun, short hard shadows, a washed-out bright sky",
  ],
  "15": [
    "late afternoon, about 15:07 local time|warm low golden sunlight and long soft shadows|{x}late afternoon, about 15:07 local time",
    "late afternoon, about 15:07 local time|warm low golden sunlight raking across everything, long shadows",
  ],
  "16": [
    "late afternoon, about 16:07 local time|warm low golden sunlight and long soft shadows|{x}late afternoon, about 16:07 local time",
    "late afternoon, about 16:07 local time|warm low golden sunlight raking across everything, long shadows",
  ],
  "17": [
    "late afternoon, about 17:07 local time|warm low golden sunlight and long soft shadows|{x}late afternoon, about 17:07 local time",
    "late afternoon, about 17:07 local time|warm low golden sunlight raking across everything, long shadows",
  ],
  "18": [
    "dusk, about 18:07 local time|orange-pink sunset through the window, a lamp just switched on|{x}dusk, about 18:07 local time",
    "dusk, about 18:07 local time|an orange-pink sunset sky, shopfront lights just coming on",
  ],
  "19": [
    "dusk, about 19:07 local time|orange-pink sunset through the window, a lamp just switched on|{x}dusk, about 19:07 local time",
    "dusk, about 19:07 local time|an orange-pink sunset sky, shopfront lights just coming on",
  ],
  "20": [
    "dusk, about 20:07 local time|orange-pink sunset through the window, a lamp just switched on|{x}dusk, about 20:07 local time",
    "dusk, about 20:07 local time|an orange-pink sunset sky, shopfront lights just coming on",
  ],
  "21": [
    "night, about 21:07 local time|warm indoor lamplight against a fully dark window|{x}night, about 21:07 local time",
    "night, about 21:07 local time|a fully dark sky, everyone lit by warm street and storefront light",
  ],
  "22": [
    "night, about 22:07 local time|warm indoor lamplight against a fully dark window|{x}night, about 22:07 local time",
    "night, about 22:07 local time|a fully dark sky, everyone lit by warm street and storefront light",
  ],
  "23": [
    "late night, about 23:07 local time|a dim room lit mostly by the cool glow of a nearby screen|{x}late night, about 23:07 local time",
    "late night, about 23:07 local time|a quiet dark street under sparse cool streetlight and neon",
  ],
};

/** hour → selectOutfit for each of the selectOutfit test's `cases` */
export const OUTFIT_TABLE: Record<string, string[][]> = {
  "4": [
    ["a/night.png"],
    ["a/NIGHT.png"],
    ["https://x/y/night.png?sig=1"],
    ["a/day.png"],
    ["only.png"],
    [],
    ["a/midnight.png"],
  ],
  "5": [
    ["a/day.png"],
    ["a/NIGHT.png"],
    ["https://x/y/day.png"],
    ["a/day.png"],
    ["only.png"],
    [],
    ["a/day.png"],
  ],
  "20": [
    ["a/day.png"],
    ["a/NIGHT.png"],
    ["https://x/y/day.png"],
    ["a/day.png"],
    ["only.png"],
    [],
    ["a/day.png"],
  ],
  "21": [
    ["a/night.png"],
    ["a/NIGHT.png"],
    ["https://x/y/night.png?sig=1"],
    ["a/day.png"],
    ["only.png"],
    [],
    ["a/midnight.png"],
  ],
  "23": [
    ["a/night.png"],
    ["a/NIGHT.png"],
    ["https://x/y/night.png?sig=1"],
    ["a/day.png"],
    ["only.png"],
    [],
    ["a/midnight.png"],
  ],
};

/** loadReference(friends/七海Nana7mi.png): data-URL length, head and tail */
export const FRIEND_REFERENCE = {
  length: 404022,
  head: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAagAAAQTCAYAAA",
  tail: "8Po1AAAAAElFTkSuQmCC",
};

/** imageSuffix by media type */
export const SUFFIXES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/x-foo": ".png",
  "IMAGE/PNG": ".png",
  "image/vnd.microsoft.icon": ".ico",
  "IMAGE/GIF": ".gif",
  "text/plain": ".txt",
  "": ".png",
};
