# Recall gaps

Partly built. The timeline for "when did you last…" questions shipped
([stream-recall.md](stream-recall.md#when-she-last-did-something)); the rest of
this page is design. Measured on 2026-11-07 against milky-green's index:
44,339 stream chunks from 925 broadcasts, 2021-07-02 to 2026-09-17, probed
through the bot's own `StreamArchive` and gate code.

The archive answers "what did she say about X" well. Before the timeline, it
couldn't answer when she last did something, and it answers questions about
viewers and their super chats only when ranking happens to favor them.
LanceDB isn't the cause. Every vector store returns the chunks most similar to
a question, and these questions ask for something else.

## When she last did something

A question like 你上次播鬼武者是什么时候 reached the topical search. That
search hands the LLM the three chunks most similar to the question, and
nothing sorts by date. A game's first session is the most "about" the game,
so it wins. Before the timeline, each of these came back with the wrong date:

| Question | Dates the LLM was given | Last time she played it |
| --- | --- | --- |
| 你上次播鬼武者是什么时候？ | 2026-09-10 ×3, the session she started it | 2026-09-17 |
| 你上次玩健身环是什么时候？ | 2022-10-03, 2022-12-23, 2023-04-22 | 2026-08-30 |
| 你什么时候玩的糖豆人？ | 2024-02-24, 2024-06-24, 2026-03-01 | 2026-04-26 |
| 你最后一次玩黑神话悟空是哪天？ | 2024-06-21, 2024-09-07 ×2 | a broadcast topic through 2026-08-21 |
| 你上次直播玩健身环是哪天？ | 2026-09-17 only, a 鬼武者 broadcast | 2026-08-30 |

Four other things made it worse:

- `recall_streams` can't help. Its `period: "all"` runs the same top-3 search.
- `LATEST` in `stream_time.ts` reads a bare 上次 as "the newest broadcast".
  Add 直播, or 播了 / 玩了 / 聊了 soon after 上次, and the turn searches only
  that broadcast. That is the table's last row.
- No time of day exists. A transcript carries `stream_date` and offsets into
  the video, nothing more. yt-dlp's `info.json` titles carry the start hour,
  as in `【直播回放】<title> 2026年09月17日19点场`. 926 of 928 broadcasts have
  it, and the titles often name the game, but the ingest never reads them.
- `prompt.md` says 不要把日期念出来, and so do the topical blocks `archive.ts`
  and `facts.ts` inject. Even a right date tends to come out vague.

With the timeline, the gate catches these turns and the catalog answers them;
a bare 上次 no longer narrows them to the newest broadcast, and the timeline
block asks for the date. Given the bot's own system prompt, default model and
facts, the persona answered the first three 九月十七号, 八月三十号 and
四月二十六号. Before, she answered 九月中旬, 猴年马月 and 今年三月.

Still open:

- **Playing versus talking.** The timeline counts scenes naming a topic. A game
  she finished in 2024 but still brings up reads as recent: asked when she last
  played 黑神话悟空, she named a September 2026 stream where she only talked
  about it.
- **Time of day**, until the `info.json` start hour reaches the catalog.
- **Her exact words.** The LLM sees the refiner's first-person retelling of
  each five-minute chunk and a couple of `key_quotes`. Once a chunk is refined,
  its transcript is neither shown nor in the FTS text.

## Viewers and super chats

The refiner keeps every SC it hears: 66,724 of them across 14,125 chunks.
Each one has the viewer's name as transcribed, the SC's text and her reply.
When a refined chunk is retrieved, its SCs reach the LLM as `SC回顾` lines,
replies included. The hard part is getting the chunk retrieved:

- **A viewer by name** works only as far as ranking allows. Three regulars
  asked about by name each had SCs in the context. But that was three chunks
  out of hundreds (one regular has 626 SCs over 258 stream days), so the bot
  can't tell a regular from a one-off. Viewer names aren't catalog topics, so
  the timeline can't help.
- **A specific SC** is found only when the refiner wrote it into the chunk's
  prose. The viewer's name is in the FTS text for 94% of SCs. The SC's own
  text is in neither the embedding input nor the FTS text, except where the
  prose repeats it. Three of five SCs asked about reached the context. One
  miss had its distinctive words only in the SC, in a seven-SC chunk whose
  prose covered the others. The other came from a viewer with 219 SCs, whose
  other chunks outranked it.
- **"你还记得我吗" or "my SC" never works.** The logged-in viewer's name and
  UID reach the prompt, but the search query is built from user turns only.
  That question returned three unrelated chunks. Mem0 holds only what the
  viewer said in past calls.
- **Names are transcriptions.** The archive has 30,290 distinct names, and
  24,390 of them appear once. The most frequent sender also appears under a
  second spelling that differs only in case. Nothing ties a name to a Bilibili
  account.

## Design for the rest

- **Viewers as timeline terms.** Add each scene's `mentions` and SC senders to
  the catalog, so a viewer's name resolves like a topic: how many SCs, first
  and last date, the latest few.
- **SC text in the index.** Add SC text and replies to the FTS text, which
  needs no re-embedding, or give them a table of their own, one SC per row.
- **Title and start hour.** Copy them from `info.json` into the transcript
  front matter, the chunks and the catalog.
- **"Me".** Add the logged-in viewer's name to the query when the gate says the
  viewer is asking about themselves. Matching by account needs the
  danmakus.com export that `laplace-extract-users` already parses. Its SCs
  carry `uId`, `uName`, `price` and `sendDate`, and its stream-start and title
  messages give the time of day.
- **Playing versus talking.** Mark the scenes where she plays, at refine time,
  so a game's timeline can count only those.
