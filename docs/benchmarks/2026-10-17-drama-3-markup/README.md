# Drama 3 markup — 2026-10-17

`persona.md` was written for S2-Pro's fixed list of English tags and ruled out
everything else: free-form wording, Chinese inside brackets, and `<>`. Drama 3,
the default `FISH_MODEL` as of this date, documents free-form `[…]`
directions in any language, sound and pause cues, and seven paired word tags
(`<whisper>`, `<emphasis>`, `<soft>`, `<fast>`, `<slow>`, `<stress>`,
`<forceful>`). This renders 22 variants, three takes each, through the bot's
Fish path and measures every flush on its own. What the numbers say: **none of
it is read aloud, a direction lasts about one sentence past where it is
written, a paired tag starts where it opens but `<whisper>` runs to the end of
its sentence, and a sound cue needs its sound written out.**

Each reply is split with Pipecat's own sentence aggregator, and every sentence
goes out with its own `flush` on one socket, as `FishAudioTTSService` sends it.
The script waits for one sentence's audio before sending the next, so each
flush can be measured alone, then transcribes it with `transcribe-1-pro`.
Settings match the bot: `latency` normal, `normalize` off, the persona's
default voice.

- `voiced` is the share of non-silent 50 ms frames with a detectable pitch.
  Plain speech scores 0.6–0.8 and a whisper under 0.1.
- `chars/s` counts spoken characters from the first to the last non-silent
  frame.
- "Heard as" counts takes whose transcript carries the matching cue, such as
  `[轻声耳语]` or `[轻笑]`. `transcribe-1-pro` writes these on its own.

## Nothing is read aloud

None of the 138 transcribed drama-3 flushes contains a word of its markup.
That covers Chinese directions (`[压低声音，像在说悄悄话]`,
`[语气温暖，带着怀念，直播杂谈]`), English and Chinese sound cues, and
`<emphasis>`, `<whisper>`, `<slow>` and `<soft>`. It also covers the closing
tags the splitter cut loose.

The same markup on `s2.1-pro` (six variants, two takes, `results-s2.1-pro.json`)
was not read aloud either, in 26 of 26 flushes. It was ignored: sentences
directed or tagged to whisper stayed voiced at 0.68–0.88. Sound cues with
their sound still laughed. Rolling `FISH_MODEL` back loses the effects but
speaks nothing extra.

## A direction carries one sentence further

The same three sentences under the direction `[压低声音，像在说悄悄话]`:

| Variant | Sentence 1 | Sentence 2 | Sentence 3 |
| --- | --- | --- | --- |
| a-plain, no markup | 0.68 | 0.74 | 0.81 |
| b-whisper-first, on sentence 1 only | 0.03, 3/3 whisper | 0.03, 3/3 | 0.53, 1/3 |
| c-whisper-each, on every sentence | 0.03, 3/3 | 0.02, 3/3 | 0.04, 3/3 |

Values are `voiced`, then takes heard as a whisper. A slow direction
(`[语速很慢，一字一顿]`) carries the same way, more mildly. Its own sentence went
from 5.82 to 4.22 chars/s, and the sentence after it was still 11% slower than
plain with no direction of its own.

The carry-over stays inside a reply. With a 10 s pause before the next flush,
standing in for a viewer's turn between two replies, the next sentence was
plain in 3/3 (o-whisper-gap). A sentence directed back with `[正常音量，轻松自然]`
was plain in 3/3 (p-whisper-override).

On `s2.1-pro` the [2026-09-19 run](../2026-09-19-tts-emotion/README.md) found a
cue colored only its own sentence.

## Paired tags start where they open

| Variant | Measured | Result |
| --- | --- | --- |
| q-whisper-tail, `我一般都能得A，<whisper>就觉得挺好的</whisper>。` | `voiced`, tagged words vs the rest | 0.14 vs 0.80, the words 22.6 dB quieter |
| g-paired-whisper, `<whisper>` around the first 19 of 30 characters | `voiced`, whole sentence | 0.04 — whispered to the end in 3/3 |
| r-emphasis vs s-emphasis-base, `<emphasis>老高兴了</emphasis>` | tagged words vs the rest: loudness, seconds per character | +1.9 dB vs −1.0 dB, 1.24× vs 0.99× |
| h-paired-slow, `<slow>` around the first 19 characters | chars/s, whole sentence | 4.29 vs 5.82 plain |

The word-level rows locate the tagged words with `transcribe-1-pro`'s
per-character timings. In q the transcript puts `[小声]` or `[轻声]` exactly where
`<whisper>` opens. A closed tag never carried into the next sentence: the
sentence after g, h and q was plain in 9 of 9 takes.

## Where the splitter cuts a tag

Pipecat's aggregator ends a sentence at `。` even inside a tag pair. Its
`SkipTagsAggregator` exists to prevent that, but `parse_start_end_tags` in
`pipecat/utils/string.py` returns at the first listed pair absent from the
text, so with several pairs only the first is protected.

- `我没事。<whisper>你先走吧。</whisper>我一会儿就来。` goes out as three flushes,
  the last opening with `</whisper>`. The tag is not read, but the whisper
  carries into `我一会儿就来` in 3/3 (i-split-whisper, `voiced` 0.02 against
  0.68 for the same line plain in j-split-plain).
- Sent as one flush with the pair intact (v-whisper-unsplit), the whisper
  still reached `我一会儿就来` in 2 of 3 takes (`voiced` 0.00, 0.23, 0.57), and
  the transcript heard no whisper in any of them. Keeping the pair whole would
  not scope it.
- `<soft>别哭了。我在呢。</soft>` leaves `</soft>` as a flush of its own. Fish
  returns no audio for it and no error (k-lone-closer).

## Sound cues need their sound

| Cue | Heard as a laugh |
| --- | --- |
| `[轻笑] 嘿嘿，…` | 3/3 |
| `[chuckling] 嘿嘿，…` | 3/3 |
| `[laughing] 哈哈哈，…` | 3/3 |
| `[轻笑] …`, nothing to laugh | 1/3 |
| `[chuckling] …`, nothing to laugh | 1/3 |
| `[laughing]…` in f-user-example, nothing to laugh | 1/3 |

Bare cues otherwise came back as an inhale (`[吸气声]`) or nothing, matching the
2026-09-19 finding on `s2.1-pro`. The English name or the Chinese one made no
difference.

## Also measured

Every flush ended in 0.2–1.0 s of silence, median 0.5 s, which a call hears
between sentences.

## Untested

What `<soft>`, `<fast>`, `<stress>` and `<forceful>` do beyond not being read
aloud; pause cues; `[sighing]`, `[gasping]` and `[yawning]` on drama-3; whether a
pause shorter than 10 s between replies still carries a direction; any voice
but the persona's default.

## Reproduce

From the repository root:

```sh
uv run python docs/benchmarks/2026-10-17-drama-3-markup/render.py --repeat 3
uv run python docs/benchmarks/2026-10-17-drama-3-markup/render.py q-whisper-tail r-emphasis
uv run python docs/benchmarks/2026-10-17-drama-3-markup/render.py --model s2.1-pro f-user-example
```

TTS is billed per character and ASR per second; `--no-asr` skips the
transcripts. Each take writes a WAV next to the script (gitignored) and merges
its per-flush metrics and transcripts into `results.json`, or
`results-<model>.json` for another model.
