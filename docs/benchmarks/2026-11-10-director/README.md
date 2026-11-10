# Director — 2026-11-10

In a group chat, the director asks Jev about every new line, the viewer's and each persona's, and
picks who answers from the scores ([chat.md](../../chat.md)). This benchmark scores its questions
on labelled lines, and checks its thresholds against them.

**The lines are synthetic.** All 100 were written by hand for this benchmark, because no group chat
has run yet. Real `decision` events from group chats replace them once there are enough of them.

## The lines

`lines.json` holds four personas and 100 situations, each among two to four of them:

| Persona | `chat.interests` | `chat.talkativeness` |
| --- | --- | ---: |
| 明前奶绿 (`milky-green`), the template as shipped | none: her summary's flower shop and cat 坚果 | 0.5 |
| 黑川茶茶 (`kuro`) | 恐怖游戏、悬疑小说、怪谈、咖啡、熬夜 | 0.4 |
| Lumi (`lumi`, 露米) | 唱歌、跳舞、偶像、演唱会、健身 | 0.9 |
| 林小满 (`xiaoman`) | 做饭、美食、数码、编程、科幻 | 0.3 |

Each line has its participants, its history and its latest line, from the viewer or a persona.
Its labels are:

- **`addressed`:** who the line speaks to, by name or by answering her. It is absent when the line
  speaks to the room, or when nobody could tell.
- **`interested`:** whose subject the line is.
- **`responders`:** who must answer it, and `maybe`, who may also answer.
- **`invites_reply`:** whether the line invites a reply or closes the exchange.

`score.ts` derives the rest the way a chat does:
- the hop is the number of persona lines since the viewer's last one;
- the mentions come from `parseMentions` on the latest line.

| Kind | Lines | What the latest line is |
| --- | ---: | --- |
| `mention` | 11 | the viewer @-mentions someone: `@`, `＠`, a Latin name in any case, or two names |
| `name` | 11 | the viewer names someone, by full or short name |
| `reply` | 10 | the viewer answers what one persona said, sometimes not the last one |
| `interest` | 17 | the viewer raises one persona's subject, addressing nobody |
| `off-topic` | 7 | the viewer's own news, nobody's subject |
| `closing` | 6 | the viewer signs off (好的晚安, 一会儿回来) |
| `group` | 3 | the viewer speaks to the room (大家晚上好, 你们俩…) |
| `persona-addresses` | 13 | a persona asks, teases or invites another |
| `persona-to-viewer` | 8 | a persona answers the viewer, or asks her back |
| `persona-opinion` | 6 | a persona gives an opinion, or praises another to the viewer |
| `persona-closing` | 6 | a persona says goodbye, thanks, or settles something |
| `persona-answers` | 2 | a persona answers another's question |

**Nine labels were changed after the first run, and all of them were loosened:**
- **The seven `off-topic` lines** required the most talkative persona, which recorded the rule
  rather than a right answer. Now any one of them may answer.
- **`group-02` (你们俩今天晚饭吃的什么)** required both personas.
- **`persona-33` (露米加油！)** required Lumi.

Every other label was written before any line was scored.

## Decisions

`score.ts` puts each line through `Director.decide` itself, with the real state, questions,
request and selection, on the gate role's model. It waits up to 30 s instead of the bot's 2 s, so
no line falls back to the rules.

The model was `~typesafe/jev-latest`, answering as `typesafe/jev-1.14-20261014`. The 101 calls,
counting one that opens the connection, cost $0.0033. On a warm connection they took 413 ms at the
median, 455 ms at p90 and 558 ms at most, so none came near the 2 s timeout. Question names such as
`addressed_milky-green` carry a persona id's hyphen, and the API accepted them.

**With the first bars (addressed 0.5, interest 0.3, invites 0.5), 90 of the 100 lines were decided
right,** and the most talkative persona took the forced answer. Mentions, names, replies, closings
and persona-to-persona questions were all right, so every failure was one of these:

| Kind | Right |
| --- | ---: |
| `interest` | 10/17 |
| `group` | 2/3 |
| `persona-opinion` | 4/6 |
| everything else | 77/77 |

### The scores

Each cell gives the number of scores, then min / median / max. Scores after a persona's line have
the hop's raise taken off, so all of them compare with the base threshold.

| Question | Labelled yes | Labelled no | Wrong side of the bar | Fewest wrong |
| --- | --- | --- | ---: | --- |
| `addressed` | 57: 0.06 / 0.93 / 0.98 | 136: −0.29 / 0.02 / 0.40 | 3 at 0.5 | 2, from 0.41 to 0.44 |
| `interested`, the raw noul | 71: 0.27 / 0.87 / 0.97 | 153: 0.03 / 0.09 / 0.90 | | 8, from 0.46 to 0.53 |
| `interested` × talkativeness | 15: 0.16 / 0.37 / 0.85 | 55: −0.21 / 0.04 / 0.15 | 6 at 0.3 | 0, from 0.15 to 0.16 |
| `invites_reply`, after a persona | 26: 0.05 / 0.77 / 0.88 | 9: −0.18 / 0.02 / 0.24 | 11 at 0.5, 3 at 0.3 | 1, from 0.25 to 0.27 |
| `invites_reply`, after the viewer (unused) | 59: 0.44 / 0.94 / 0.98 | 6: 0.07 / 0.12 / 0.22 | | 0, from 0.23 to 0.44 |

The interest product is scored only where interest decides: lines with no mention and nobody
addressed. Its yes points are the responders whose subject the line is; its no points are the
personas whose subject it isn't, who mustn't answer on interest.

### What the scores show

- **`addressed` separates cleanly.** Every addressed persona scored 0.55 or more after the raise,
  except on two lines:
  - 茶茶 teased by her short name scored 0.44. The state names her 黑川茶茶 only.
  - 你们俩 scored 0.06 and 0.08: Jev doesn't read a plural as addressing either persona.

  The highest score for someone nobody addressed was 0.40, for 楼下花店的绣球开得好漂亮 and the
  florist. The range with fewest wrong, 0.41 to 0.44, is narrower than Jev's ±0.05 between repeat
  calls. No decision changes anywhere from 0.45 to 0.6.
- **The forced answer goes to the wrong persona.** When nobody clears the interest bar, the most
  talkative persona answers. 小满's talkativeness of 0.3 caps her product at 0.3, so 红烧肉怎么做才不腻
  went to Lumi, with an interest of 0.08, over 小满's 0.94. Four of the seven `interest` misses are
  hers. The other three are 奶绿's.
- **奶绿, with no `chat.interests`, scores low on her own subjects.** Her summary names the flower
  shop and 坚果. Yet on the `interest` lines, two about cats scored her interest at 0.32, and
  情人节送花 at 0.53; only 绣球 reached 0.78. On their own subjects, the personas with interests
  scored from 0.67 to 0.97.
- **Opinions, praise and anecdotes land under the invites bar.** After a persona's line, Jev scores
  them from 0.37 to 0.68, which is 0.27 to 0.48 after the raise, all under 0.5. Two lines praising
  Lumi to the viewer went unanswered, though her interest scored 0.95 and 0.96. Every persona line
  labelled as inviting no reply scored 0.24 or less after the raise.
- **`interested` counts being part of the conversation as a stake.** 茶茶 scored 0.87 to 0.90 on
  three persona lines that answer her, among them 那就这么说定了, which names none of her subjects.
  No decision changes, because being addressed is checked first.

## What changed in `director.ts`

Replaying the stored scores through the selection rules, with other bars, gave the results below.
`director.ts` took the second row: `INVITES_THRESHOLD` is 0.3, and below the interest bar the
viewer's forced answer goes to the top-ranked candidate, the more talkative of a tie. With it,
`--cached` decides all 100 lines right, and `decisions.json` holds that replay.

| Change | Lines decided right |
| --- | ---: |
| none (the first bars) | 90/100 |
| `INVITES_THRESHOLD` 0.3, and the forced answer going to the top-ranked candidate | 100/100 for an interest bar anywhere from 0.1 to 0.4 |
| `INVITES_THRESHOLD` 0.3, the most talkative still forced | 100/100 only for an interest bar of 0.16 or less, which sits on the highest no score, 0.15 |

With the change, each bar can move on its own, in steps of 0.01, without deciding a line wrong:
the addressed bar from 0.4 to 0.63 at least, the interest bar from 0.1 to 0.43, and the invites bar
from 0.17 to 0.38. Under 0.1, the interest bar lets a second persona follow on two lines.

## Reproduce

From the repository root, with the gate role's key (`OPENROUTER_API_KEY` by default) in `.env` or
the environment:

```sh
bun run director-decisions
bun docs/benchmarks/2026-11-10-director/score.ts
bun docs/benchmarks/2026-11-10-director/score.ts --cached
```

- **`director-decisions`** runs `score.ts --check`. It asks Jev about every line, writes
  `decisions.json`, and exits non-zero when any line is decided wrong. It costs about $0.003.
- **Without `--check`,** `score.ts` exits 0, for calibration.
- **`--cached`** re-decides the scores stored in `decisions.json` through the director instead of
  asking Jev, so it costs nothing. Use it after changing a threshold or a label; a changed question
  or state needs a real run.
- **`--persona <id>`** picks whose gate role it calls.

Each `OFF` line it prints is one question's score on the wrong side of its threshold. That is a
diagnostic, and it never fails the check, because a line whose decision comes out right anyway is
fine.
