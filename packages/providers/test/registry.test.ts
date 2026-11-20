// The registry: each kind of model keeps its implementations in a table keyed by provider id, and
// every provider the catalog offers a kind from must implement it there, as no other may.
import { describe, expect, test } from "vitest";
import { type Category, PROVIDER_IDS, PROVIDERS } from "../src/catalog.ts";
import { DECISION_MODELS } from "../src/decision/index.ts";
import { LISTINGS } from "../src/models.ts";
import { REALTIME_DIALECTS } from "../src/realtime/session.ts";
import { SEARCHERS } from "../src/search.ts";
import { SYNTHESIZERS } from "../src/speech/batch/synthesize.ts";
import { TRANSCRIBERS } from "../src/speech/batch/transcribe.ts";
import { SPEECH_STREAMS } from "../src/speech/stream/index.ts";
import { STT_STREAMS } from "../src/stt/index.ts";

const offering = (category: Category) =>
  PROVIDERS.filter((provider) => provider.offers[category] !== undefined)
    .map((provider) => provider.id)
    .sort();

const KINDS: readonly (readonly [string, Category, object])[] = [
  ["live speech recognition", "stt", STT_STREAMS],
  ["batch speech recognition", "stt", TRANSCRIBERS],
  ["streaming speech", "tts", SPEECH_STREAMS],
  ["batch speech", "tts", SYNTHESIZERS],
  ["realtime voice", "realtime", REALTIME_DIALECTS],
  ["decision models", "decision", DECISION_MODELS],
  ["web search", "search", SEARCHERS],
];

describe("the registry", () => {
  test.each(KINDS)(
    "%s: implemented by exactly the providers that offer it",
    (_kind, category, table) => {
      expect(Object.keys(table).sort()).toEqual(offering(category));
    },
  );

  test("every provider lists its models, but Fish's closed set and the two without a listing", () => {
    const unlisted = ["fish", "cartesia", "minimax"];
    expect(Object.keys(LISTINGS).sort()).toEqual(
      PROVIDER_IDS.filter((id) => !unlisted.includes(id)).sort(),
    );
  });
});
