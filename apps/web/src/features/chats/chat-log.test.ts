// Group chat replies place the Why Answered button beside the active bubble or photo group
// rather than on a new line below VoiceBubble or HerPhotos, while keeping <audio>'s DOM nesting
// intact for apps/bot/scripts/local-smoke.ts. Rendered to markup with the macros and avatars stubbed.
import type { Attachment, ParticipantId } from "@eidolon/chat";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";
import type { ChatItem } from "./items";
import type { ChatPersona } from "./persona";
import { IDLE } from "./stream";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// Her picture's version store has no server snapshot.
vi.doMock("@/components/avatar", () => ({ PersonaAvatar: () => null }));

const { ChatLog } = await import("./chat-log");

const MILKY: ChatPersona = {
  id: "milky-green",
  name: "明前奶绿",
  shortName: "奶绿",
  avatar: false,
  appearance: { model: null },
};

const KURO: ChatPersona = {
  id: "kuro",
  name: "黑川茶茶",
  shortName: "茶茶",
  avatar: false,
  appearance: { model: null },
};

const AUDIO: Extract<Attachment, { readonly kind: "audio" }> = {
  kind: "audio",
  name: `${"a".repeat(64)}.mp3`,
  mime: "audio/mpeg",
  durationMs: 10_000,
};

const IMAGE: Attachment = {
  kind: "image",
  name: `${"b".repeat(64)}.png`,
  mime: "image/png",
};

const GROUP_REASON = {
  source: "model" as const,
  scores: {
    "addressed_milky-green": 0.9,
    "interested_milky-green": 0.8,
    invites_reply: 0.7,
  },
  to: { kind: "user" as const },
};

const SOLO_REASON = {
  source: "single" as const,
  scores: {},
  to: { kind: "user" as const },
};

function renderLog(items: readonly ChatItem[], personas: readonly ChatPersona[] = [MILKY, KURO]) {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const byId = new Map<ParticipantId, ChatPersona>(personas.map((p) => [p.id, p]));
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(ChatLog, {
        chatId: "0199a3f2-7c1e-7d40-9b6a-3f5e8c2d1a07",
        display: "normal",
        personas,
        personaOf: (id) => byId.get(id) ?? MILKY,
        items,
        live: IDLE,
        next: null,
        lateTools: [],
        retry: null,
        autoPlay: null,
        onAutoPlayEnd: () => {},
        inCall: false,
        call: null,
        onSend: () => {},
        onSendVoice: () => {},
        focusTask: null,
        onFocused: () => {},
        footer: null,
      }),
    ),
  );
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Slices out the `depth`-th enclosing `<div>...</div>` around the first occurrence of `marker`
 * (`depth = 0` is the immediate parent `<div>`).
 */
function divAround(markup: string, marker: string, depth: number): string {
  const markerAt = markup.indexOf(marker);
  expect(markerAt).toBeGreaterThan(-1);
  const stack: number[] = [];
  const enclosing: Array<[number, number]> = [];
  for (const match of markup.matchAll(/<\/?div\b[^>]*>/g)) {
    const at = match.index;
    if (match[0].startsWith("</")) {
      const start = stack.pop();
      if (start !== undefined && start <= markerAt && markerAt < at) {
        enclosing.push([start, at + match[0].length]);
      }
    } else {
      stack.push(at);
    }
  }
  const span = enclosing[depth];
  expect(span).toBeDefined();
  return markup.slice(span![0], span![1]);
}

function openingTag(html: string): string {
  return html.slice(0, html.indexOf(">") + 1);
}

type PersonaItem = Extract<ChatItem, { readonly kind: "persona" }>;

function personaReply(overrides: Partial<Omit<PersonaItem, "kind">> = {}): PersonaItem {
  return {
    kind: "persona",
    seq: 1,
    persona: MILKY.id,
    text: "",
    images: [],
    voice: null,
    sentAsText: false,
    interrupted: false,
    cutOff: null,
    reason: GROUP_REASON,
    call: false,
    ...overrides,
  };
}

describe("ChatLog group decision info alignment", () => {
  const whyLabel = 'aria-label="Why 奶绿 Answered"';

  test("places Why Answered beside the voice player pill above Show Transcript and keeps audio nesting", () => {
    const markup = renderLog([personaReply({ text: "听我说哦", voice: AUDIO, interrupted: true })]);

    expect(countOccurrences(markup, whyLabel)).toBe(1);

    const playerPill = divAround(markup, "<audio ", 0);
    expect(playerPill).toContain('aria-label="Play Voice Message"');
    expect(playerPill).toContain("rounded-bl-md bg-muted");

    const voiceRoot = divAround(markup, "<audio ", 1);
    const rootClasses = openingTag(voiceRoot);
    expect(rootClasses).toContain("grid");
    expect(rootClasses).toContain("grid-cols-[minmax(0,16rem)_auto]");
    expect(rootClasses).toContain("gap-x-0.5");
    expect(voiceRoot).toContain("Show Transcript");
    expect(voiceRoot).toContain(whyLabel);

    const asideWrapper = divAround(voiceRoot, whyLabel, 0);
    expect(openingTag(asideWrapper)).toContain("flex self-end");

    const transcriptBox = divAround(voiceRoot, "Show Transcript", 0);
    expect(openingTag(transcriptBox)).toContain("col-start-1");
    expect(openingTag(transcriptBox)).toContain("min-w-0");

    // Visual and keyboard focus order: Play -> Info -> Show Transcript.
    expect(voiceRoot.indexOf("Play Voice Message")).toBeLessThan(voiceRoot.indexOf(whyLabel));
    expect(voiceRoot.indexOf(whyLabel)).toBeLessThan(voiceRoot.indexOf("Show Transcript"));

    const herBubble = divAround(markup, "<audio ", 3);
    expect(herBubble).toContain("Interrupted");
    expect(countOccurrences(herBubble, whyLabel)).toBe(1);
  });

  test("omits the second grid column for solo voice replies and viewer voice messages", () => {
    const soloMarkup = renderLog(
      [personaReply({ text: "听我说哦", voice: AUDIO, reason: SOLO_REASON })],
      [MILKY],
    );
    const soloRoot = openingTag(divAround(soloMarkup, "<audio ", 1));
    expect(soloRoot).toContain("grid-cols-[minmax(0,16rem)]");
    expect(soloRoot).not.toContain("grid-cols-[minmax(0,16rem)_auto]");
    expect(soloRoot).not.toContain("gap-x-0.5");
    expect(soloMarkup).not.toContain("Why ");

    const userMarkup = renderLog([
      {
        kind: "user",
        seq: 2,
        text: "我发了一条语音",
        voice: AUDIO,
        call: false,
      },
    ]);
    const userVoiceRoot = divAround(userMarkup, "<audio ", 1);
    const userRootTag = openingTag(userVoiceRoot);
    expect(userRootTag).toContain("grid-cols-[minmax(0,16rem)]");
    expect(userRootTag).not.toContain("gap-x-0.5");
    expect(userMarkup).not.toContain("Why ");
    const userTranscript = openingTag(divAround(userVoiceRoot, "Show Transcript", 0));
    expect(userTranscript).toContain("col-start-1");
    expect(userTranscript).toContain("items-end");
  });

  test("keeps Why Answered beside text bubbles even when status badges follow", () => {
    const markup = renderLog([
      personaReply({ text: "别催啦", sentAsText: true, cutOff: "length" }),
    ]);

    expect(countOccurrences(markup, whyLabel)).toBe(1);
    const wordsRow = divAround(markup, "别催啦", 1);
    expect(openingTag(wordsRow)).toContain("flex max-w-[80%] items-end gap-0.5");
    expect(wordsRow).toContain(whyLabel);

    const badgeRow = divAround(markup, "Sent as text", 0);
    expect(badgeRow).toContain("Cut off");
    expect(badgeRow).not.toContain(whyLabel);
  });

  test("places Why Answered beside photo-only replies and does not repeat it beside mixed replies", () => {
    const photoOnly = renderLog([personaReply({ images: [IMAGE] })]);
    expect(countOccurrences(photoOnly, whyLabel)).toBe(1);
    const photosRow = divAround(photoOnly, "<img ", 2);
    expect(openingTag(photosRow)).toContain("flex max-w-full items-end gap-0.5");
    expect(photosRow).toContain(whyLabel);
    expect(photosRow.indexOf("<img ")).toBeLessThan(photosRow.indexOf(whyLabel));

    const voiceWithPhoto = renderLog([personaReply({ seq: 2, images: [IMAGE], voice: AUDIO })]);
    expect(countOccurrences(voiceWithPhoto, whyLabel)).toBe(1);
    expect(divAround(voiceWithPhoto, "<audio ", 1)).toContain(whyLabel);
    expect(divAround(voiceWithPhoto, "<img ", 2)).not.toContain(whyLabel);

    const textWithPhoto = renderLog([personaReply({ seq: 3, text: "看看这张", images: [IMAGE] })]);
    expect(countOccurrences(textWithPhoto, whyLabel)).toBe(1);
    expect(divAround(textWithPhoto, "看看这张", 1)).toContain(whyLabel);
    expect(divAround(textWithPhoto, "<img ", 2)).not.toContain(whyLabel);
  });

  test("falls back to the badge row when a cut-off reply has no text, voice, or photos", () => {
    const markup = renderLog([personaReply({ cutOff: "refusal" })]);
    expect(countOccurrences(markup, whyLabel)).toBe(1);
    const badgeRow = divAround(markup, "Cut off", 0);
    expect(badgeRow).toContain(whyLabel);
  });
});
