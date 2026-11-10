# Finalize acknowledgement — 2026-11-10

When the VAD hears speech stop, the Ear calls `stt.finalize()`, and the recognizer answers once it
has finalized everything before it: Soniox with its `<fin>` token, Deepgram with a final `Results`
marked `from_finalize`. The answer comes even when nothing was said, as after a cough.

Today the TurnDetector ends a turn on a finalized final, or on any final once the recognizer's
`ttfsP99` has passed since speech ended (0.35 s for both, a constant from pipedog). A turn with no
words has no final, so a cough's empty turn lasts until the 5 s watchdog ends it.

U20 changes that: a turn ends as soon as the recognizer acknowledges `finalize()`, words or none,
and the wait for that acknowledgement is capped at p99 + 1 s. This benchmark measures that p99.

**The questions:**
- How long after `finalize()` does each recognizer acknowledge it, after speech, after a cough and
  in silence?
- How often does no acknowledgement come at all?
- Is G5's gate reachable? It asks a cough during her reply to end its empty turn in under 1.5 s.

## Method

`measure.ts` measures Soniox, and Deepgram when an account of it has a key. It uses the active
persona's hearing role when that is one of the two. Otherwise it uses the provider's first account
with a key, on the catalog's default model (`--deepgram-model` picks Deepgram's).

**It speaks each recognizer's wire itself.** Today's clients drop an acknowledgement with no words:
Soniox's `#endpoint()` says nothing for a `<fin>` with no final tokens before it, and Deepgram's
client emits nothing for an empty transcript. `SttStream.events` can't show the case this is about.
So the script takes the clients' own URL and configuration (`sonioxUrl`, `sonioxConfig`,
`deepgramUrl`, `sttLanguage`), opens the socket with `connectWs`, and reads each acknowledgement as
U20's clients will report it:
- **Soniox:** the `<fin>` token. Its event carries the final tokens since the previous `<fin>`, as
  `final {finalized}`, or nothing as a bare `finalized`.
- **Deepgram:** the final `Results` with `from_finalize`. Its event carries that message's
  transcript.

The audio is 16 kHz mono in 20 ms frames, sent on the clock as a call's arrive, over continuous room
tone (seeded Gaussian noise, σ 60, about −55 dBFS). After a 1 s lead-in it plays round after round
of three episodes, each ending in one `finalize()`:

| Case | Before it | The sound | `finalize()` |
| --- | --- | --- | --- |
| speech | 0.4 s of room tone | one of 8 short Mandarin sentences (1.0–1.9 s) | 0.2 s after the speech ends |
| cough | 0.4 s of room tone | a 150–300 ms synthetic cough | 0.2 s after the cough ends |
| silence | 1.0 s of room tone | none | at the end of the room tone |

The 0.2 s is `VAD_STOP_SECS`, where a call's VAD stop edge calls `finalize()`. A real stop also waits
on the volume's smoothing, so it can come a little later.

**The sounds:**
- **Speech:** no recording is kept in the repository, so the sentences are rendered by macOS
  `say -v "Flo (Chinese (China mainland))"`, the voice `e2e-call.ts` uses. They are converted with
  ffmpeg and trimmed to the first and last sample above 300, since `say` pads half a second of
  silence. They are cached in `$TMPDIR/eidolon-finalize-ack-audio`.
- **Cough:** seeded Gaussian noise through a one-pole high-pass at 250 Hz and a one-pole low-pass at
  3 kHz. It has a 10 ms linear attack and an exponential decay whose time constant is a quarter of
  its length, and peaks at −6 dBFS. The lengths cycle through 150, 200, 250, 300, 175, 225 and 275
  ms.

**Waiting for the acknowledgement:** the script waits up to 5 s for each one, streaming room tone,
then plays 0.3 s more before the next episode.
- **Never:** no acknowledgement within 5 s.
- **Late:** an acknowledgement that comes after 5 s but before the next `finalize()`, recorded as
  `lateMs`. It still counts as never.
- **Unmatched:** an acknowledgement with no `finalize()` waiting, counted per provider.

Rounds continue while the audio streamed, plus the next episode at its worst (never acknowledged),
stays within 3 minutes. That is at least 24 finalizes even if none is acknowledged, and about 90
when they come fast.

**The summary:**
- **Percentiles** are by nearest rank over the acknowledged finalizes. Below 100 of them, p99 is the
  maximum.
- **U20's cap** is the provider's p99 over all its cases, plus 1 s, counted from `finalize()`.
- **The gate** counts from the end of the cough. The empty turn ends at the VAD's 0.2 s stop, then
  at the coughs' p99 acknowledgement. A cough never acknowledged ends at the cap, 0.2 s + cap after.
  The gate is reachable when the first is under 1.5 s, and so is the second if any cough went
  unacknowledged.

Two things the summary leaves out:
- **Smart Turn's analysis,** about 88 ms on an M4 Max, which runs alongside the wait.
- **The network path.** The latencies include it from wherever the script runs, so run it where the
  bot runs, or note where it ran.

**Cost:** it reports usage through `Meter` and `reportUsage`, as the clients do, into the usage
ledger. At the catalog's prices, 3 minutes is at most $0.006 on Soniox (`stt-rt-v5`, $0.12/h) and
$0.023 on Deepgram (`nova-3-general`, $0.462/h). The script prints its estimate before it connects.

## Reproduce

```bash
bun docs/benchmarks/2026-11-10-finalize-ack/measure.ts [--persona <id>] [--deepgram-model <id>]
```

It writes every finalize to `results.json` beside the script, or to `--out <file>`, and prints a
table per provider. It needs macOS `say` with the Flo (Chinese) voice, and ffmpeg.

Deepgram's default `nova-3-general` may not take `language=zh`. If its handshake is refused, the run
skips it at no cost. Run it again with `--deepgram-model nova-2-general`.

`--fake` runs the same schedule, with a 60 s budget, against a fake Soniox and a fake Deepgram on
127.0.0.1 (`fake.ts`). It spends nothing, and fails unless:
- every finalize's case, latency and words match the fakes' script, including one never answered
  and one answered late;
- the summary matches the script's;
- the arithmetic matches figures worked out by hand;
- the usage reported equals the audio streamed.

## Results

- **Run:** 2026-11-10, persona milky-green, whose hearing role is Soniox `stt-rt-v6` with the
  language detected. From a development Mac whose traffic leaves through a US proxy, so not
  production's path to Soniox. 87 finalizes over 175 s of audio, $0.0058. `results.json` holds
  every one. Deepgram was skipped: no Deepgram account has a key.
- **Soniox acknowledges every finalize,** with words or without: a cough or plain room tone gets a
  bare `<fin>`. None went unanswered within 5 s.

  | case | n | acked | with words | p50 | p90 | p99 | max |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | speech | 29 | 29 | 29 | 346 | 490 | 758 | 758 |
  | cough | 29 | 29 | 0 | 306 | 492 | 912 | 912 |
  | silence | 29 | 29 | 0 | 325 | 400 | 414 | 414 |
  | all | 87 | 87 | 29 | 324 | 414 | 912 | 912 |

  Milliseconds from `finalize()` to its acknowledgement. With 87 samples, p99 is the maximum.
- **U20's cap, p99 + 1 s: 1.91 s** after `finalize()`.
- **The G5 gate is reachable.** At the coughs' p99, a cough's empty turn ends 1.11 s after the
  cough: the VAD's 200 ms stop, then the acknowledgement. One never acknowledged would end at the
  cap, 2.11 s after.
- **Decision:** U20 ends a turn as soon as its last `finalize()` is acknowledged, and waits at most
  1.91 s for that. Both clients report a bare acknowledgement as the `finalized` event.
