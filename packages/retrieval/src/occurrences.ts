// Which archived broadcasts a topic turns up in, newest first: what "when did you last play X"
// needs and similarity search can't rank. A term is a refined scene topic the question contains;
// a scene names it in its heading, summary or topics.
import { cpLen } from "@eidolon/config";
import { Slicer } from "./slicer.ts";
import type { Broadcast, BroadcastScene } from "./stream_catalog.ts";

// A topic only one scene carries is too often a one-off phrase to stand for a thing.
const MIN_TERM_SCENES = 2;
const LATIN = /[a-z0-9]/;

/** Whether `text` contains `term`, as a whole word where the term starts or ends in Latin. */
function contains(text: string, term: string): boolean {
  const open = LATIN.test(term[0] ?? "");
  const close = LATIN.test(term.at(-1) ?? "");
  if (!open && !close) return text.includes(term);
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
    if (open && LATIN.test(text[at - 1] ?? "")) continue;
    if (close && LATIN.test(text[at + term.length] ?? "")) continue;
    return true;
  }
  return false;
}

export interface Occurrence {
  readonly broadcast: Broadcast;
  /** The broadcast's scenes that name the timeline's terms, in broadcast order. */
  readonly scenes: readonly BroadcastScene[];
}

export interface Timeline {
  readonly terms: readonly string[];
  /** Newest first. */
  readonly occurrences: readonly Occurrence[];
}

interface Entry {
  readonly broadcast: Broadcast;
  readonly texts: readonly string[];
}

export class OccurrenceIndex {
  readonly #entries: readonly Entry[];
  readonly #terms: readonly string[];

  private constructor(entries: readonly Entry[], terms: readonly string[]) {
    this.#entries = entries;
    this.#terms = terms;
  }

  /** `broadcasts` newest first, as StreamCatalog keeps them. */
  static async build(broadcasts: readonly Broadcast[]): Promise<OccurrenceIndex> {
    const slicer = new Slicer();
    const counts = new Map<string, number>();
    const entries: Entry[] = [];
    for (const broadcast of broadcasts) {
      await slicer.tick();
      const texts = broadcast.scenes.map((scene) => {
        // The catalog loader doesn't check topic types, and a throw here would fail the boot warm.
        const topics = scene.topics.map((topic) => String(topic).toLowerCase());
        for (const topic of new Set(topics)) counts.set(topic, (counts.get(topic) ?? 0) + 1);
        return `${scene.heading}\n${scene.summary}\n${topics.join("\n")}`.toLowerCase();
      });
      entries.push({ broadcast, texts });
    }
    const terms = [...counts]
      .filter(([topic, count]) => count >= MIN_TERM_SCENES && cpLen(topic) >= 2)
      .map(([topic]) => topic);
    return new OccurrenceIndex(entries, terms);
  }

  /**
   * The broadcasts whose scenes name every term `query` contains, or, when no scene names them
   * all, the one term the fewest scenes name. Null when `query` contains no known topic.
   */
  async timeline(query: string): Promise<Timeline | null> {
    const terms = this.#termsIn(query);
    if (terms.length === 0) return null;
    const occurrences = await this.#occurrences(terms);
    if (occurrences.length > 0) return { terms, occurrences };
    let fewest: Timeline | null = null;
    let fewestScenes = Number.POSITIVE_INFINITY;
    for (const term of terms) {
      const alone = await this.#occurrences([term]);
      const scenes = alone.reduce((sum, occurrence) => sum + occurrence.scenes.length, 0);
      if (scenes > 0 && scenes < fewestScenes) {
        fewestScenes = scenes;
        fewest = { terms: [term], occurrences: alone };
      }
    }
    return fewest;
  }

  #termsIn(query: string): string[] {
    const text = query.toLowerCase();
    const found = this.#terms.filter((term) => contains(text, term));
    return found.filter((term) => !found.some((other) => other !== term && other.includes(term)));
  }

  async #occurrences(terms: readonly string[]): Promise<Occurrence[]> {
    const slicer = new Slicer();
    const occurrences: Occurrence[] = [];
    for (const { broadcast, texts } of this.#entries) {
      await slicer.tick();
      const scenes = broadcast.scenes.filter((_, s) =>
        terms.every((term) => contains(texts[s] ?? "", term)),
      );
      if (scenes.length > 0) occurrences.push({ broadcast, scenes });
    }
    return occurrences;
  }
}
