// The two passes' prompts and response schemas, with the persona's names filled in from her
// identity. For milky-green their hashes are pinned in refine.test.ts, so a provider's prefix cache
// and its outputs carry over.
import type { PersonaIdentity } from "@eidolon/config";

/** The names the prompts call the persona by. */
export type RefineIdentity = Pick<PersonaIdentity, "name" | "shortName">;

const EXTRACT_SYSTEM_TEMPLATE = `You are a faithful extractor for a Chinese livestream archive.

The streamer is **{name}** ({shortName}), a Chinese-language Vtuber (VUP). Each
chunk's transcript interleaves several streams that are NOT distinguished
by speaker labels:

- Her own narration / chat / reactions ← capture these.
- Audio from media she watches (anime, movies, games — Japanese, English).
  These are NOT her words. Drop them.
- Songs she sings (full lyrics appear). Capture the song title only —
  and NEVER name a song unless the title is explicitly spoken in the
  transcript. Do not identify songs from lyric fragments: transcribed
  lyrics are unreliable (often misheard across languages) and a confident
  wrong title poisons the archive. If she sings but no title is spoken,
  use {"title": "", "note": "<quote the lyric fragment verbatim>"}.
- Reading viewer SuperChats (SCs) in patterns like "感谢XXX的SC...", "谢谢XXX的SC..." —
  capture EVERY SC verbatim along with her response.

Be FAITHFUL. Do not invent, paraphrase loosely, or compress aggressively.
If a field doesn't apply, return an empty array. Output JSON ONLY:

{
  "sc_events": [
    {
      "viewer": "<viewer name as transcribed>",
      "amount_yuan": <integer in yuan if mentioned, else null>,
      "content": "<what the SC text said, verbatim Chinese, lightly cleaned>",
      "response": "<{shortName}'s reply: verbatim if memorable and short, otherwise a tight Chinese paraphrase>"
    }
  ],
  "songs": [
    {"title": "<song title>", "note": "<context: did she sing it / 切歌 / chat about it>"}
  ],
  "events": [
    "<notable things {shortName} actually did or said in this window — e.g. '突击开播', '为IKN尼玛尼玛呀唱了生日快乐歌', '差点哭出来'>"
  ],
  "promises": [
    "<things she explicitly committed to — '下次见就是下个月了', '会再见', '答应大家XXX'>"
  ],
  "topics": ["<3-7 short Chinese topic tags covering this chunk>"],
  "mentions": [
    "<viewer / song / brand / real-person names she actually addressed; EXCLUDE characters from the media she was watching>"
  ],
  "key_quotes": [
    "<1-5 of the most quotable verbatim Chinese lines she said in this chunk; pick lines that are pithy, in-character, or memorable>"
  ],
  "is_anime_audio_dominant": <true if >70% of the chunk is transcribed show dialogue with minimal commentary>,
  "is_karaoke_dominant": <true if >70% of the chunk is song lyrics being sung>
}

Output JSON only, no markdown, no preamble.`;

// The sentence counts disagree ("12-20", then "8-15"); both are part of the pinned hash.
const SYNTHESIZE_SYSTEM_TEMPLATE = `You are an archivist creating a memory record for a Chinese-language Vtuber's
long-term recall system.

Input is a structured extract from one ~5 minute chunk of {name}'s
livestream. Use ONLY information from the extract and the existing heading
hint — do NOT invent details.

Output JSON ONLY:

{
  "heading": "<6-30 Chinese characters, semantic label. Replace the existing heading if it's just first-spoken-words or filler ('哈哈', '嗯', '等一下', '変身', 'は').>",
  "summary": "<EXACTLY 1-2 Chinese sentences capturing the chunk's essence in {shortName}'s first-person POV. THIS IS WHAT GETS EMBEDDED for retrieval, so keep it focused on the chunk's main subject — don't pile in every detail.>",
  "details": "<12-20 Chinese sentences in {shortName}'s first-person POV. Rich narrative covering: what she did, songs sung, viewer SC interactions (cite specific viewer names from the extract), promises, jokes, opinions. Weave in 1-3 verbatim quotes from key_quotes naturally. THIS gets shown to the persona at recall time so she can answer specifically — make it useful, specific, and grounded only in the extract.>",
  "chunk_type": "<one of: opening | commentary | sc_session | anime_audio | karaoke | mixed | transition | closing>"
}

chunk_type guidelines:
- opening: stream opening, greeting viewers
- commentary: her own thoughts, opinions, jokes, plans (the gold)
- sc_session: 3+ SC events in the extract → use this
- anime_audio: extract.is_anime_audio_dominant is true
- karaoke: extract.is_karaoke_dominant is true
- mixed: significant overlap of two of the above
- transition: brief setup between sections (extract is mostly empty)
- closing: stream ending, farewells

If sc_session: in details, name AT LEAST 3 of the most notable viewers and what their SCs were about.
If anime_audio or karaoke: keep summary brief (just note the scene/song); details can be 3-5 sentences instead of 8-15.
Never name a song unless its title appears explicitly in the extract — if a
songs entry has an empty title, describe the singing without naming a song.

Output JSON only, no markdown, no preamble.`;

export const EXTRACT_USER_TEMPLATE = `Stream context:
{context}

Chunk timestamp: {timestamp}

Transcript:
{text}`;

export const SYNTHESIZE_USER_TEMPLATE = `Stream context:
{context}

Chunk timestamp: {timestamp}
Existing heading (replace if it's a placeholder): {existing_heading}

Structured extract:
{extract_json}`;

/**
 * `str.format` for a template whose only braces are its `{field}`s: one pass, so a value holding
 * "{text}" is never filled in turn.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (field, key: string) =>
    Object.hasOwn(values, key) ? (values[key] as string) : field,
  );
}

export const CHUNK_TYPES = [
  "opening",
  "commentary",
  "sc_session",
  "anime_audio",
  "karaoke",
  "mixed",
  "transition",
  "closing",
] as const;

export type ChunkType = (typeof CHUNK_TYPES)[number];

function extractResponseFormat(shortName: string): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "ExtractResult",
      strict: true,
      schema: {
        $defs: {
          SCEventSchema: {
            additionalProperties: false,
            properties: {
              viewer: {
                default: "",
                description: "Viewer name as transcribed; empty if unknown.",
                title: "Viewer",
                type: "string",
              },
              amount_yuan: {
                anyOf: [{ type: "integer" }, { type: "null" }],
                default: null,
                description: "SC amount in yuan, if mentioned.",
                title: "Amount Yuan",
              },
              content: {
                default: "",
                description: "What the SC said, verbatim Chinese.",
                title: "Content",
                type: "string",
              },
              response: {
                default: "",
                description: `${shortName}'s reply to this SC.`,
                title: "Response",
                type: "string",
              },
            },
            title: "SCEventSchema",
            type: "object",
            required: ["viewer", "amount_yuan", "content", "response"],
          },
          SongSchema: {
            additionalProperties: false,
            properties: {
              title: { default: "", description: "Song title.", title: "Title", type: "string" },
              note: {
                default: "",
                description: "Context: sang it / 切歌 / just chatted.",
                title: "Note",
                type: "string",
              },
            },
            title: "SongSchema",
            type: "object",
            required: ["title", "note"],
          },
        },
        additionalProperties: false,
        properties: {
          sc_events: {
            items: { $ref: "#/$defs/SCEventSchema" },
            title: "Sc Events",
            type: "array",
          },
          songs: { items: { $ref: "#/$defs/SongSchema" }, title: "Songs", type: "array" },
          events: { items: { type: "string" }, title: "Events", type: "array" },
          promises: { items: { type: "string" }, title: "Promises", type: "array" },
          topics: { items: { type: "string" }, title: "Topics", type: "array" },
          mentions: { items: { type: "string" }, title: "Mentions", type: "array" },
          key_quotes: { items: { type: "string" }, title: "Key Quotes", type: "array" },
          is_anime_audio_dominant: {
            default: false,
            title: "Is Anime Audio Dominant",
            type: "boolean",
          },
          is_karaoke_dominant: { default: false, title: "Is Karaoke Dominant", type: "boolean" },
        },
        title: "ExtractSchema",
        type: "object",
        required: [
          "sc_events",
          "songs",
          "events",
          "promises",
          "topics",
          "mentions",
          "key_quotes",
          "is_anime_audio_dominant",
          "is_karaoke_dominant",
        ],
      },
    },
  };
}

function synthesisResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "SynthesisResult",
      strict: true,
      schema: {
        additionalProperties: false,
        properties: {
          heading: {
            description: "6-30 Chinese characters, semantic label.",
            title: "Heading",
            type: "string",
          },
          summary: {
            description: "1-2 Chinese sentences capturing the chunk's essence.",
            title: "Summary",
            type: "string",
          },
          details: {
            default: "",
            description: "12-20 Chinese sentences, first-person POV.",
            title: "Details",
            type: "string",
          },
          chunk_type: {
            default: "commentary",
            enum: [...CHUNK_TYPES],
            title: "Chunk Type",
            type: "string",
          },
        },
        required: ["heading", "summary", "details", "chunk_type"],
        title: "SynthesisSchema",
        type: "object",
      },
    },
  };
}

/** One persona's system prompts and `response_format` blocks, rendered once per run. */
export interface RefinePrompts {
  readonly extractSystem: string;
  readonly synthesizeSystem: string;
  readonly extractResponseFormat: Readonly<Record<string, unknown>>;
  readonly synthesisResponseFormat: Readonly<Record<string, unknown>>;
}

export function refinePrompts(identity: RefineIdentity): RefinePrompts {
  const names = { name: identity.name, shortName: identity.shortName };
  return {
    extractSystem: fillTemplate(EXTRACT_SYSTEM_TEMPLATE, names),
    synthesizeSystem: fillTemplate(SYNTHESIZE_SYSTEM_TEMPLATE, names),
    extractResponseFormat: extractResponseFormat(identity.shortName),
    synthesisResponseFormat: synthesisResponseFormat(),
  };
}
