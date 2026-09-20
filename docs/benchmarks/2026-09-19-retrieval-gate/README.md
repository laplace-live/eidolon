# Retrieval gate — 2026-09-19

Jev (`~typesafe/jev-latest`, answering as `typesafe/jev-1.13-20260917`) now
decides per turn whether the bot searches LanceDB. Across four real calls,
turns that ask nothing about the streamer went from a median 4.9 s to 1.5 s
between the user aggregator and the LLM. Turns that need her memories kept
their retrieval and timing, 4.8 s before and 4.7 s after, and their replies
stayed grounded. How the gate works is in
[retrieval-gate.md](../../retrieval-gate.md).

## Live calls

Each call ran through the unmodified `bot()`, `/api/offer`, and
SmallWebRTC on this machine, with an aiortc client in the same process.
The client sent RTVI client-ready for the real greeting turn, then spoke six
lines (macOS `say -v Tingting`), waiting after each reply until the bot had
been silent for 2 s. The viewer was anonymous, so Mem0 was off. The two
before-calls ran on unmodified `a38cec9`; the two after-calls ran with the
gate on. All four used the same audio.

The retrieval stage runs from the context frame leaving the user aggregator
to its arrival at the LLM. First audible reply runs from the line's last
sample, or client-ready, to the first audible bot audio the client receives.

| Line | Gate | Retrieval stage, before | after | First audible reply, before | after |
| --- | --- | ---: | ---: | ---: | ---: |
| (greeting) | skip | 4.8 / 5.0 s | 1.4 / 1.3 s | 15.3 / 14.2 s | 7.7 / 6.6 s |
| 我今天加班好累啊。 | skip | 4.5 / 4.6 s | 0.4 / 0.5 s | 12.0 / 11.6 s | 5.1 / 6.9 s |
| 你喜欢吃纳豆吗？ | retrieve | 4.8 / 4.9 s | 5.0 / 5.3 s | 17.0 / 12.9 s | 13.1 / 13.8 s |
| 哈哈哈，好吧。 | skip | 5.2 / 4.9 s | 1.6 / 1.6 s | 11.1 / 10.2 s | 7.1 / 7.7 s |
| 坚果是什么品种的猫？ | retrieve | 4.6 / 4.8 s | 4.4 / 5.2 s | 12.8 / 14.5 s | 12.1 / 14.2 s |
| 你是不是说过你不敢去网吧？ | retrieve | 5.3 / 4.5 s | 4.5 / 4.4 s | 18.7 / 13.7 s | 10.0 / 14.1 s |
| 好的，我先去吃饭了，一会儿回来。 | skip | 5.5 / 7.6 s | 1.9 / 2.1 s | 8.3 / 11.4 s | 5.6 / 23.8 s |

| Median over both calls | Retrieval stage, before | after | First audible reply, before | after |
| --- | ---: | ---: | ---: | ---: |
| Skipped turns, 8 | 4.9 s | 1.5 s | 11.5 s | 7.0 s |
| Retrieving turns, 6 | 4.8 s | 4.7 s | 14.1 s | 13.4 s |

Each seven-turn call made 14 embedding and 14 rerank requests before, and 6
of each after, plus 10 Jev decisions at about $0.00001 apiece. Both
after-calls decided every line the same way: skip the greeting and the three
chit-chat lines, retrieve for the three questions about her.

Where a skipped turn is slower than 0.5 s, the gate's HTTP connection is
the cause, not the decision:

- **Greeting.** The first gate call of a session opens a TLS connection,
  1.3–1.4 s.
- **Split lines.** VAD split 哈哈哈，好吧 into two user turns and the goodbye
  line into three, in all four calls. Overlapping gate calls opened a second
  connection (1.3 s). The stage time also spans the first, interrupted turn.

First audible reply is noisy because the LLM's first text took anywhere from
2.5 s to 21.3 s across the calls. The 23.8 s after-call goodbye is one of
those stalls, so compare retrieval stages.

Replies to retrieving turns kept their grounding. 纳豆 still drew the story
of eating a whole box plain, 坚果 was still a black ragdoll that spills its
food, and 网吧 still recalled the fight she saw there. Skipped turns
answered in character from the conversation alone.

In the before-calls, the first embedding and first rerank of each turn took
~1.5 s and ~2.0 s, against ~0.5 s for the second of each pair. Both clients
use httpx's default 5 s keep-alive, so each turn reopens their connections.
That cost was left alone here.

## Decisions

`decisions.py` puts 191 labeled viewer turns through the gate's own state,
questions, model, and threshold of 0.3:

| Set | Needs recall, kept | Chit-chat, skipped | Lowest recall score |
| --- | ---: | ---: | ---: |
| dev — chose the questions and threshold | 51/51 | 40/52 | 0.58 |
| held-out — scored once | 30/30 | 25/30 | 0.70 |
| fresh — checks the flower-shop edit | 12/12 | 7/10 | 0.88 |
| all | 93/93 | 72/92 | 0.58 |

Sequential calls on a warm connection took 460 ms at the median and 528 ms
at p90. Six borderline turns carry no label, and their scores are printed.
Repeating one input five times moved its score by at most 0.05.

## Reproduce

From the repository root:

```sh
uv run python docs/benchmarks/2026-09-19-retrieval-gate/decisions.py
uv run python docs/benchmarks/2026-09-19-retrieval-gate/call.py after-3
```

`decisions.py` costs about $0.002. Each call makes real Soniox, OpenRouter,
and Fish Audio requests, takes about two minutes, and needs macOS for
`say`. Its label names the output file. To measure the ungated path, set
`RETRIEVAL_GATE_ENABLED=false` in `.env`; `bot.py` loads `.env` over the
shell's environment.
