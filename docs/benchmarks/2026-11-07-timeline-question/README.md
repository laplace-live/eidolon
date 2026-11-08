# Timeline question — 2026-11-07

The retrieval gate's request now also asks Jev whether the viewer asks when,
or how often, the streamer did something: 你上次播鬼武者是什么时候,
你第一次玩博德之门是什么时候, 你玩过几次糖豆人. Those turns get the catalog's
timeline instead of the three most similar chunks
([stream-recall.md](../../stream-recall.md#when-she-last-did-something)).

Three questions, any one at or above 0.7, in the same call as the gate's
three:

- `last_time`: when she last did, played, sang, or talked about a specific
  thing, or how long ago that was
- `first_time`: when she did something for the first time
- `how_often`: how many times or how often she has done something

## Decisions

`score.ts` puts 65 labeled viewer turns through the gate's own state,
questions and model (`~typesafe/jev-latest`, answering as
`typesafe/jev-1.14-20261014`):

| Set | Timeline turns kept | Other turns below | Lowest timeline score | Highest other score |
| --- | ---: | ---: | ---: | ---: |
| dev — chose the questions and threshold | 18/18 | 19/19 | 0.80 | 0.60 |
| held-out — scored once | 12/12 | 14/14 | 0.72 | 0.53 |

The other turns include the near misses that matter: questions about the
newest broadcast (你上次直播聊了什么, 0.22), dated questions (上周你玩了什么游戏,
the highest at 0.60), the future (你下次什么时候播鬼武者) and what rather than
when (你上次说的那个游戏叫什么来着). Every timeline turn also cleared the gate's
own threshold, so none would be skipped.

Two wordings were dropped on dev. A first-time question asking "when the
streamer first did, played, sang, or talked about a specific thing" scored
0.61 on 我什么时候能看到你玩健身环 and only 0.62 on a real first-time turn. A
broader "when did she do something" question scored 0.95 on
最近一次直播几点下播的.

Adding the three questions to the gate's call left its median latency where
it was (376 against 382 ms on a 30-turn check) and moved the gate's own
scores by at most 0.05, Jev's usual jitter between repeat calls.

The held-out set's lowest timeline turn, 鬼武者你是哪天通关的, sat at 0.72,
close to the threshold. A miss costs only what every such turn cost before:
the similarity search's chunks. A false fire replaces them with a timeline,
and only when the turn names a topic the catalog has.

## Reproduce

From the repository root, with `OPENROUTER_API_KEY` in `.env` or the
environment:

```sh
bun docs/benchmarks/2026-11-07-timeline-question/score.ts
```

It costs about $0.001, writes `results.json`, and exits non-zero if any
labeled turn lands on the wrong side of the threshold.
