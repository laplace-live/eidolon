# Fish flush timing — 2026-11-10

Fish marks no segment boundaries. Today the native engine sends a reply's sentences on one Fish
session as they come, each as `text` and `flush` ([voice-engine.md](../../voice-engine.md#speaking)),
so it can't tell which sentence is playing. From G5 it is meant to send sentence k+1 only once
sentence k's audio has gone quiet for `FISH_SEGMENT_IDLE_MS`, which would place every boundary
exactly (D12: "completed" events spread across the audio).

That works only if two things hold:
- each flush's audio comes as one burst and then nothing, with no pause inside a burst as long
  as the threshold;
- the threshold is short enough that sentence k+1's audio arrives before sentence k's runs out.

`measure.ts` answers, on Fish's live socket:

1. **Does each flush's audio arrive as one burst, followed by a detectable idle gap?** If not, G5
   stops here and the plan is revisited; no runtime mode switch ships instead.
2. **What idle threshold tells "the burst paused" from "the burst ended", with margin?**
3. **How long from a flush to its first audio,** and **does a 表演提示 direction still carry** when
   the sentence that sets it and the one after it are separate flushes?

## What it does

- **It speaks through the bot's own client.** `openSpeech()` gives the `FishSpeech` the bot uses,
  for the voice role of the persona `--persona` names, or the active one: its account, model and
  voice from the settings layers, with the same URL, headers, start message and MessagePack
  framing. It loads the `.env` and the settings files as the `laplace-*` commands do.
- **It waits 2 s before the first flush** (`--warm-ms`). The bot opens a session at call setup,
  long before a reply, so the first flush's time to audio should leave out the handshake.
- **The serial run** sends the 16 sentences below on one session, each as `text` and `flush`. It
  stamps every audio message with `performance.now()` and its byte length, and sends the next
  sentence only once 2.5 s have passed with no audio (`--settle-ms`), or 15 s with none at all.
  Then it sends `stop` and keeps whatever audio still comes: a burst that outlasted 2.5 s of quiet
  shows up there.
- **The pipelined run** opens a new session and sends the first four sentences at once, then
  `stop`, as G2 sends a reply today.
- **It writes:**
  - `results.json` beside the script (`--out`): every arrival of every flush and the summary;
  - the serial run's audio as a WAV (`--wav`), and the pipelined run's beside it as
    `<name>-pipelined.wav`. WAVs are gitignored.
- **It reports its usage.** The client's meter reports the characters sent to the usage ledger,
  as a job.
- **It costs about $0.013.** That is 489 characters and 1255 bytes on drama-3, at its promotional
  price until 2026-12-01, and about $0.063 after. It prints the estimate before sending anything,
  and refuses to run past 600 characters.

## The sentences

They are mini-replies in 奶绿's register. Each opens with one direction, as `prompt.md` asks. The
drama-3 benchmark ([2026-10-17](../2026-10-17-drama-3-markup/README.md)) found that a direction
lasts about one sentence past where it is written, and that a 10 s pause resets it. So the
sentence after each direction carries no direction of its own, and a plain direction follows to
reset it.

| # | Text | Listen for |
| ---: | --- | --- |
| 1 | `[压低声音，像在说悄悄话] 跟你说个秘密哦。` | a whisper |
| 2 | `其实我昨天背着店长，偷偷吃了三块小蛋糕。` | **carry:** still a whisper |
| 3 | `[正常音量，轻松自然] 好啦，不说这个了。` | plain again |
| 4 | `[懒洋洋的，带点笑意] 嗯……今天花店人好多。` | lazy, smiling |
| 5 | `[chuckling] 嘿嘿，我一个人包了二十多束花，<emphasis>手都酸了</emphasis>。` | a laugh on 嘿嘿; 手都酸了 stressed |
| 6 | `嗯，好。` | short |
| 7 | `[语速很慢，一字一顿] 你、听、好、了。` | slow, one word at a time |
| 8 | `明天下午三点，花店门口，不见不散。` | **carry:** still slower than plain |
| 9 | `[正常音量，轻松自然] 开玩笑的啦，你别当真，嗯。` | plain again |
| 10 | `[温柔地安慰] 别难过了，我在呢。` | gentle |
| 11 | `我没事，<whisper>你先走吧</whisper>。` | **carry:** still gentle; whispered from 你先走吧 |
| 12 | `一会儿我就过来找你，记得给我留一杯奶绿，少糖少冰，嗯。` | voiced: the whisper closed a flush before |
| 13 | `[突然来劲，语速变快] 哎呀你知道吗！` | fast and excited |
| 14 | `坚果以前最喜欢趴在收银台上晒太阳，谁摸它它就翻肚皮，客人都说它才是真店长，对吧。` | **carry:** still fast |
| 15 | `[有点失落，慢慢地说] [sighing] 唉…它跑路那天，我也是这种感觉，嗯。` | a sigh on 唉, then slow |
| 16 | `[laughing] 哈哈哈，好啦好啦，不聊了，晚安！` | a laugh on 哈哈哈 |

In every row, no markup may be heard as words. The serial flushes are at least 2.5 s apart, longer
than G5 would wait. A direction that carries here should therefore carry at G5's shorter wait.
One that doesn't is worth a second run with `--settle-ms` near the suggested threshold.

## What it reports

For each serial flush:

| Column | Meaning |
| --- | --- |
| first ms | from the flush to its first audio |
| burst ms | from its first audio to its last |
| max gap | the largest gap between two of its audio messages |
| msgs, audio s | its audio messages, and their seconds at 44.1 kHz, 16-bit mono |
| slack ms | its audio's length minus its burst's: how long before its audio, played from its first message on, would run out the burst ended |
| wait ms | from its last audio to the next flush: the settle, plus timer slack |
| wav s | where it starts in the serial WAV |

Over the whole run:
- the spread (p50, p90, p99, max) of every gap inside a burst, and of flush to first audio;
- the audio after the stop;
- the pipelined run's first audio, its gaps, the three largest with where they fell in its audio,
  and how long it would stall if played as it came;
- the suggested `FISH_SEGMENT_IDLE_MS` and its projection;
- the verdict.

**The projection** replays the serial run as G5 would send it at the suggested threshold. Each
flush goes the threshold after the previous flush's last audio, and its audio comes at the offsets
measured from its own send. It then plays the result from the first message on. The silence that
falls before each sentence is what serial flushing would add to the gap a listener hears between
sentences, on top of the silence Fish puts at the end of each one. It assumes each sentence's text
is ready when its turn comes, whereas in a call the mind may still be writing it.

**The verdict** is "no clean separation", G5's stop condition, when any of these holds:
- the session failed;
- a flush brought no audio;
- audio came after the stop, so a burst outlasted 2.5 s of quiet;
- the suggested threshold is not under the 2.5 s the run waited, so a pause can't be told from
  the end of a burst within the window.

Separately, the report flags a projection that adds more than 100 ms at the median boundary,
since G5's bar is pipedog's gap between sentences plus 100 ms.

## The margin

**The suggested `FISH_SEGMENT_IDLE_MS` is the largest gap seen inside any burst, rounded up to
10 ms, plus the larger of 100 ms and half that gap.** The two ways to be wrong cost differently:
- **Too low, it fires inside a burst.** The next sentence goes while the current one's audio is
  still coming. Fish queues it behind that audio, as it does every segment in the pipelined run,
  so nothing sounds wrong. Only that boundary lands early, at the pause, which moves one "completed"
  event and what `heard()` keeps on a barge-in.
- **Too high, it can be heard.** Once the threshold plus the next flush's time to audio outlasts
  the current sentence's slack, the listener hears that much more silence between sentences.

So the margin covers what this run can't see, and no more:
- **The 100 ms floor is the bot's event loop.** The Mouth's idle timer shares the main thread with
  the Ear, and each turn's end costs about 88 ms of main-thread work
  ([voice-engine.md](../../voice-engine.md#hearing)). A gap measured here as X can look like
  X + 90 ms in a call where the caller talks over her.
- **Half the gap is the network.** One run sees 16 bursts, on the path the measuring machine
  takes to Fish, which isn't production's. Network jitter scales with the path, so the margin
  scales with the gaps it produced.

The projection shows what the suggested value costs. A value the projection says is heard
needs a decision, not a bigger margin.

## Results

- **Run:** 2026-11-10, persona milky-green, `drama-3` on her own Fish voice, from a development
  Mac whose traffic leaves through a US proxy, so not production's path to Fish.
  `results.json` holds every arrival.
- **Verdict: clean separation.** Every serial flush's audio came as **one message**, 0.5–1.9 s after
  its flush, and nothing else came until the next flush; no audio came after the stop, and the
  finish came 205 ms after it. With one message per flush there is no gap inside a burst to measure.
- **`FISH_SEGMENT_IDLE_MS` = 100.** The largest gap inside a burst was 0 ms, so the value is the
  margin alone (the event loop's floor). Projected at 100 ms, serial flushing adds no silence before
  any sentence (p50, p90 and max 0 ms over 15 boundaries): each sentence's audio arrives while the
  sentences before it are still playing.
- **Time to first audio:**

  | | p50 | p90 | max |
  | --- | ---: | ---: | ---: |
  | serial flush | 947 ms | 1501 ms | 1907 ms |

  The pipelined run's first audio came 1079 ms after its four flushes, in four messages over
  1616 ms with gaps up to 865 ms, and would not have stalled played as it came.
- **Markup:** none was read aloud. A transcript of the serial WAV by her hearing role reads the 16
  sentences' words and nothing else: no direction, `<emphasis>`, `<whisper>` or cue spoken.
- **Listening (still to do, by ear):** whether each direction carries into the next flush (pairs
  1→2, 7→8, 10→11, 13→14). A transcript can't tell. The serial WAV is not committed (WAVs are
  gitignored); rerun the script to make one.
- **Decision:** G5 takes serial flushes with a 100 ms idle threshold. Because Fish answered each
  flush in one message on this run, a longer threshold would only add delay; if a later model
  streams a flush in several messages, rerun this script before changing the value.

## Reproduce

The script speaks through the bot's own Fish client. The run above used G2's client, which sent a
reply's sentences as they came. Since G5 that client sends each sentence only once the last has
gone quiet, so a rerun's pipelined pass is serial too, and only its serial pass still measures
what it did here.

From the repository root, with the voice role's key (`FISH_API_KEY` by default) in `.env`,
`credentials.json` or the environment:

```sh
bun docs/benchmarks/2026-11-10-fish-flush/measure.ts --dry-run
bun docs/benchmarks/2026-11-10-fish-flush/measure.ts --wav <path>
bun test --no-env-file docs/benchmarks/2026-11-10-fish-flush
```

- **`--dry-run`** prints the persona, account, model, endpoint, characters and estimated cost, and
  sends nothing. It is free.
- **`--wav <path>`** is where the serial run's audio goes; without it, `serial.wav` beside the
  script.
- **`--out <path>`, `--persona <id>`, `--settle-ms <n>` and `--warm-ms <n>`** are as above.
- **The test** runs the whole script against a fake Fish on 127.0.0.1, with no `.env`, and checks
  the arithmetic on fixed timings. It is free.
