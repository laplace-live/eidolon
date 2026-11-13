import { describe, expect, test } from "bun:test";
import {
  cueEmoji,
  isPairedTag,
  isPauseCue,
  parseMarkup,
  parseMarkupWithState,
  type Scheduler,
  STUCK_DELAY_MS,
  stripCues,
  THINKING_DELAY_MS,
  trimTrailingPartialCue,
  type WaitState,
  Watchdog,
} from "../src/index.ts";

describe("inline delivery-cue markup", () => {
  test("parses cues, directions, paired tags, and space-eating pauses", () => {
    expect(cueEmoji("Chuckling")).toBe("😄");
    expect(cueEmoji("unknown-cue")).toBeUndefined();
    expect(isPairedTag("whisper")).toBe(true);
    expect(isPairedTag("script")).toBe(false);
    expect(isPauseCue("break")).toBe(true);
    expect(isPauseCue("long-break")).toBe(true);
    expect(isPauseCue("happy")).toBe(false);

    const kept = parseMarkup("[chuckling][温柔地]你好<whisper>悄悄话</whisper>[break] 世界");
    expect(kept).toEqual([
      { kind: "cue", start: 0, name: "chuckling", emoji: "😄" },
      { kind: "direction", start: 11, text: "温柔地" },
      { kind: "text", start: 16, text: "你好", tags: [] },
      { kind: "text", start: 27, text: "悄悄话", tags: ["whisper"] },
      { kind: "text", start: 48, text: "世界", tags: [] },
    ]);

    const dropped = parseMarkup("[温柔地] 你好", { directions: "drop" });
    expect(dropped).toEqual([{ kind: "text", start: 6, text: "你好", tags: [] }]);
  });

  test("preserves open paired tags across spoken and unspoken boundaries", () => {
    const first = parseMarkupWithState("<whisper>前半句", { directions: "drop" });
    expect(first).toEqual({
      tokens: [{ kind: "text", start: 9, text: "前半句", tags: ["whisper"] }],
      openTags: ["whisper"],
    });

    const second = parseMarkupWithState("后半句</whisper>普通", {
      directions: "drop",
      initialTags: first.openTags,
    });
    expect(second).toEqual({
      tokens: [
        { kind: "text", start: 0, text: "后半句", tags: ["whisper"] },
        { kind: "text", start: 13, text: "普通", tags: [] },
      ],
      openTags: [],
    });
  });

  test("strips cues without synthesizing new tags and trims partial trailing cues", () => {
    expect(stripCues("[懒洋洋] <whisper>你好</whisper>  世界")).toBe("你好 世界");
    expect(stripCues("<<b>script>alert(1)</script>")).not.toContain("<script>");
    expect(trimTrailingPartialCue("你好[温柔")).toBe("你好");
    expect(trimTrailingPartialCue("你好<whis")).toBe("你好");
    expect(trimTrailingPartialCue("你好[温柔]")).toBe("你好[温柔]");
  });
});

class FakeClock implements Scheduler {
  now = 0;
  readonly #tasks = new Map<number, { at: number; fn: () => void }>();
  #nextId = 1;

  set(fn: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#tasks.set(id, { at: this.now + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.#tasks.delete(handle);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, task] of [...this.#tasks.entries()]) {
      if (task.at <= this.now) {
        this.#tasks.delete(id);
        task.fn();
      }
    }
  }
}

describe("Watchdog", () => {
  test("transitions idle → thinking → stuck unless llmStarted or clear cancels it", () => {
    const clock = new FakeClock();
    const seen: WaitState[] = [];
    const watchdog = new Watchdog((state) => seen.push(state), clock);

    watchdog.arm();
    expect(watchdog.state).toEqual({ thinking: false, stuck: false });

    clock.advance(THINKING_DELAY_MS - 1);
    expect(watchdog.state).toEqual({ thinking: false, stuck: false });

    clock.advance(1);
    expect(watchdog.state).toEqual({ thinking: true, stuck: false });

    clock.advance(STUCK_DELAY_MS - THINKING_DELAY_MS);
    expect(watchdog.state).toEqual({ thinking: true, stuck: true });

    watchdog.clear();
    expect(watchdog.state).toEqual({ thinking: false, stuck: false });
    expect(seen).toEqual([
      { thinking: true, stuck: false },
      { thinking: true, stuck: true },
      { thinking: false, stuck: false },
    ]);

    // llmStarted cancels only the stuck timer while keeping thinking visible until audio starts.
    watchdog.arm();
    clock.advance(THINKING_DELAY_MS);
    watchdog.llmStarted();
    clock.advance(STUCK_DELAY_MS * 2);
    expect(watchdog.state).toEqual({ thinking: true, stuck: false });
    watchdog.clear();
    expect(watchdog.state).toEqual({ thinking: false, stuck: false });
  });
});
