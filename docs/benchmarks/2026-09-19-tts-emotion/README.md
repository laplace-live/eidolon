# TTS expressiveness — 2026-09-19

The bot's replies sounded flat. This renders one real reply nine ways through
the same Fish WebSocket path `FishAudioTTSService` uses, three takes each, and
measures how much the delivery moves. What the numbers say: **where the cues sit
in the text matters, and the request parameters barely do.**

Every take uses the persona's default voice and this reply from a real call:

```text
[nostalgic] 他其实是一只黑色的布偶猫。虽然性格看着一点都不像布偶，反而像个高冷的理工猫，嗯。
```

`loudness std` is the spread of 50 ms frame loudness in dB over non-silent
frames, and `pitch std` the spread of an autocorrelation f0 estimate in
semitones. Both are proxies for how much the delivery moves, not judgments of
whether it sounds good — the WAVs are here to listen to. Pitch std never
separated the variants (3.9–4.6 everywhere), so read loudness.

| Variant | Change | Loudness std, 3 takes | First audio |
| --- | --- | ---: | ---: |
| a-s2pro | model `s2-pro` | 6.98 (6.5–7.7) | 1867 ms |
| b-s21pro | model `s2.1-pro`, else identical | 7.98 (6.6–9.2) | 1879 ms |
| c-temperature | b + `temperature` 0.9, `top_p` 0.9 | 7.91 (7.3–8.8) | 1876 ms |
| d-no-loudness-norm | b + `prosody.normalize_loudness` false | 7.90 (7.5–8.4) | 1904 ms |
| e-whole-reply | b + one generation instead of per sentence | 7.75 (7.1–8.5) | 3227 ms |
| f-cue-per-sentence | b + a cue opening every sentence, `[chuckling] 嘿嘿` among them | **9.92 (8.8–10.9)** | 1918 ms |
| g-all | f + temperature + no loudness norm | **10.06 (9.4–11.4)** | 1919 ms |
| h-freeform | b + free-form English cues per sentence | **9.74 (9.4–10.0)** | 1956 ms |
| i-emotion-per-sentence | b + emotion cues per sentence, no added words | 8.49 (8.1–9.0) | 1977 ms |

## What holds up

**A cue only colors the sentence it sits in.** Pipecat splits replies on
sentence boundaries and sends each sentence to Fish followed by a `flush`, so
each sentence is generated on its own. A reply that opens with one cue and then
runs two more sentences delivers those two neutrally. Moving cues onto every
sentence is the largest measured change (b → f, +1.9 dB of loudness spread) and
costs no latency, because the first sentence is unchanged.

**A vocal event needs its paired text.** `transcribe-1-pro` heard a chuckle in
every f take (`[轻笑]` inline) and in none of b or i. Emotion-only cues (i) move
the numbers a little but produce no audible event, matching Fish's guidance to
put text such as 嘿嘿 after a sound cue.

**Free-form cues do not leak.** Six renders with cues like
`[a little nostalgic, fondly]` and `[amused and warm]` never spoke those words:
transcripts match the plain reply. They perform like the fixed tags (h 9.74 vs
f 9.92). Fish documents S2 bracket cues as free-form natural language with
intensity modifiers (`[slightly sad]`, `[very excited]`), which `persona.md`
currently forbids.

**`s2.1-pro` reads slightly livelier than `s2-pro`** (6.98 → 7.98 mean, ranges
overlapping) at the same latency, and Fish recommends it for production.

## What does not

- `temperature` 0.9 / `top_p` 0.9: 7.91 against a 7.98 baseline. Fish documents
  temperature as controlling expressiveness, but on this line it did nothing
  measurable, and higher values risk unstable takes.
- `prosody.normalize_loudness` false: 7.90. Loudness normalization was not
  flattening the dynamics.
- One generation per reply instead of per sentence: no gain (7.75) and
  1.35 s more before the first audio, since nothing is spoken until the whole
  reply is written.

## Untested

The voice model itself bounds all of this. A reference recording with a wider
emotional range raises the ceiling for every variant above, and no parameter
here can exceed what the clone was built from.

## Reproduce

From the repository root:

```sh
uv run python docs/benchmarks/2026-09-19-tts-emotion/render.py --repeat 3
uv run python docs/benchmarks/2026-09-19-tts-emotion/render.py f-cue-per-sentence
```

Each take is billed per character and writes `<variant>.wav` next to the script,
merging metrics into `results.json`. `transcripts.json` holds the
`transcribe-1-pro` readings quoted above. WAVs are gitignored.
