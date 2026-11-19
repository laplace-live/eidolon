---
name: persona-update
description: Find a persona's new streams on Bilibili and YouTube and save them as a batch her Studio can transcribe, her official replays first (on Bilibili, her space's 直播回放 list), others' full recordings only where she has no replay, clips only when asked. Use when asked to update or add to a persona's streams, archive or sources.
---

# Persona update

Finds the videos of a persona's streams that her sources don't hold yet, ranks them, and saves
them as one batch in her sources. Eidolon's Studio then downloads the batch, prices it and
transcribes it. This skill never does: those steps bill the owner and run for hours.

The batch is written by `eidolon discover --save` into her sources, outside the task's folder.
That batch is the deliverable; nothing goes into the task's folder.

## What you need

- **The `bash` tool.** Without it, stop and report that this needs commands, and that the
  persona's Videos tab in Eidolon's Studio adds videos by link.
- **`eidolon`**, on your commands' PATH: Eidolon's own command line, run as the owner. Each
  command you run waits for the owner's OK on the task's card, so run few. `eidolon discover`
  prints JSON.
- **The persona's id.** `$EIDOLON_TASK_PERSONA` holds the id of the persona whose chat started
  this task. When the brief is about another persona, use her id; a wrong one makes `discover`
  list the ids there are.

## Her livestream recordings on Bilibili

A streamer's livestream recordings on Bilibili are her space's **直播回放** list, which Bilibili
fills from her own live room: every stream, whole, as she streamed it. Its URL follows this
pattern:

```text
https://space.bilibili.com/<mid>/lists/<list id>?type=series
```

明前奶绿's, for one, is `https://space.bilibili.com/2132180406/lists/2484684?type=series`. This list
is the official source: find it, give it to `discover` in this form, and name it in your report.
A space's other lists (covers, highlights, a game's 合集) and fans' collections are not it.

## The tiers, best first

1. **official:** her 直播回放 list on Bilibili (or a 录播 list on her own space), or her YouTube
   channel's past live streams.
2. **recordings:** someone else's upload of a whole stream, an hour or longer, kept only for a
   date that has no official replay and no transcript yet.
3. **clips:** shorter uploads. They repeat what her streams hold, and each is dated by the day it
   was uploaded, which would throw off her answers to "when did you last…". Take them only when the
   brief asks for clips (`--clips`).

## Steps

1. **Look.** Run `eidolon discover --persona "$EIDOLON_TASK_PERSONA"` with a timeout of 300
   seconds: it reads her lists and pages through Bilibili's search. Read `persona`, `channels`,
   `warnings`, and each tier's `count`, `hours` and `videos`, one video to a line. A first fill
   can list hundreds; when the output is cut, `bash_output` pages the rest. Later commands can name
   her by the id `persona.id` gives.
2. **Check her channels.** Each Bilibili entry of `channels` should be a list URL in the pattern
   above, its `list` 直播回放 (or 录播) and its `name` her account. A warning says when a list
   isn't a 直播回放 or 录播 list, or a space has none; then her full streams only come from search.
3. **Find her 直播回放 list, if `channels` is empty.** No official channel is known yet:
   - `candidates` lists the Bilibili accounts named like her, those whose space has a 直播回放
     list first, each list in `replayLists` by its URL in the pattern above. Only a streamer's
     own space has one, but a namesake can stream too: check the account by its name,
     `verified`, `fans` and `liveRoom`. `videos` leaves out her lists, so a small count proves
     nothing.
   - If no candidate has one, search the web for her Bilibili space
     (`https://space.bilibili.com/<mid>`) or her 直播回放 list. Given a space, `discover` finds
     its 直播回放 list itself, and prints and saves it by the list's URL.
   - If she streams on YouTube, find her channel (`https://www.youtube.com/@handle`) the same way.
   - Run step 1 again with `--channel <url>` for each official channel, her 直播回放 list's URL
     when you have it. A wrong one makes a stranger's uploads count as hers, so pass only a
     channel you are sure of; when you can't be sure, save nothing and say why.
   - Once a batch is saved with it, `discover` remembers the channel: the batch's `# Source:` line
     names the list's URL.
4. **Check the lists.** Read the titles and uploaders. Leave out, with `--skip <url>` for each, a
   video that isn't one of her streams: another streamer of a similar name, a stream that is
   someone else's with her as a guest, a compilation. Keep the rest; when in doubt, keep it.
5. **Save.** Run the same command again with `--save`, and the same `--channel`, `--skip` and
   `--clips` flags. It writes one batch, official videos first, and gives its path in `batch`.
   Nothing new means no batch: her sources are up to date.
6. **Report**, in the owner's language:
   - the persona, and her official channels by their URLs, with how you found a new one;
   - for each tier, how many videos and hours, and the newest date;
   - the batch's file name, or that nothing was new;
   - what you left out and why: skipped videos, clips not asked for, and `warnings`;
   - what's next: in Eidolon's Studio, her Videos tab downloads the batch, then shows what
     transcribing it costs before anything is billed.

## Options

- `--pages N`: Bilibili search pages, 20 videos each (default 5). For a persona whose sources are
  still empty, `--pages 20` reaches further back.
- `--min-minutes N`: the shortest full stream (default 60). Lower it only for a streamer whose
  streams are often shorter.

## Never

- Never run `eidolon pipeline`, `download`, `transcribe`, `refine`, `ingest-streams` or
  `ingest-facts`: they bill the owner, and outlast a command's 30-minute limit. Studio runs them.
- Never write to her sources any other way: `discover --save` is the only writer here.
