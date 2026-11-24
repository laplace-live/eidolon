# Avatars

A persona can have character models: 2D models made in
[PSD2Live](https://github.com/tsunehimatoi/psd2live), which Eidolon draws with PSD2Live's own
runtime. Eidolon never makes a model. The owner makes one in PSD2Live, exports its `.p2lrt`, and
imports that in the studio's Appearance section, which previews it and makes one of her models the
one she shows. The SDK's avatar entry draws a model and moves it with her: her mood from the cues
she writes, her mouth from her voice, her gaze and gestures from a call's turns. Models live only
in the owner's data home, so only the local app shows them.

The kind is `psd2live` in code and files, "2D model" is the plain word, and the app labels one
"2D Model · PSD2Live". A `.p2lrt` is PSD2Live's own format and needs no Cubism Core; Live2D is
Live2D Inc.'s trademark for Cubism models, so Eidolon never calls these Live2D. In the app the
feature is **Appearance** (形象), since "avatar" is already her picture and "models" her AI models,
and the wire and server types are `CharacterModel*`.

```text
packages/sdk/src/avatar/                 @laplace.live/eidolon-sdk/avatar: the stage, direct(),
                                         the moods, the mouth and framing
packages/sdk/src/avatar/psd2live/        the PSD2Live adapter: runtime.ts loads the wasm, rig.ts
                                         and renderer.ts are the ported web player, model.ts the
                                         model the stage draws
packages/sdk/src/avatar/psd2live/wasm/   PSD2Live's runtime, byte for byte, with its licenses
apps/bot/src/local/psd2live.ts           the upload check: the same wasm, run by the local server
apps/bot/src/local/appearance.ts         her models on disk, which routes/appearance.ts serves
apps/web/src/features/studio/            the studio's Appearance section
apps/web/src/components/model-stage.tsx  the stage in the app, which falls back to her picture
apps/bot/test/local/fixtures/psd2live/   tml.p2lrt, the CC0 test rig
```

**Licenses.** PSD2Live's runtime and its web player are MIT (`Copyright (c) 2026 PSD2Live
contributors`). `rig.ts` and `renderer.ts` are ported from the player and keep its MIT header, and
the wasm ships unchanged beside its `LICENSE` and the licenses of the crates compiled into it;
`packages/sdk` keeps `LICENSE-psd2live` and `THIRD_PARTY.md`, and `NOTICE` has a PSD2Live section.
Everything else here, the SDK's own avatar code, the server's routes and check, and the studio's
section, is Eidolon's, under the AGPL-3.0. PSD2Live's editor is GPL-3.0, and Eidolon never bundles
or runs it, nor Cubism Core. A model's own license is its author's: models stay in the data home,
and the page fetches a model's file with the session's proof, which a service on another port can't
send ([web-app.md](web-app.md#security)).

## A persona's models

```text
<data home>/personas/<id>/models/<model>/
  model.p2lrt    the file as imported, byte for byte
  model.json     what PSD2Live's runtime read of it, and the owner's settings for it
```

- **Only in the data home.** The app reads a persona's models from her folder in the data home
  alone, never from a template under `personas/`, and writes them through a temporary file and a
  rename. A folder that lacks either file, or holds a `model.json` the app didn't write, lists
  nothing.
- **The id** is the folder's name, which the server makes from the uploaded file's name: without
  `.p2lrt`, NFC and lowercase, each run of anything but `[a-z0-9_-]` a `-`, at most 64 characters,
  `model` when nothing is left, then `-2`, `-3`… past the names taken. It is never a path a request
  gives, nor an id written into `model.json`, and every route checks the one it is sent against the
  persona ids' pattern, `^[a-z0-9][a-z0-9_-]{0,63}$`, before looking it up.
- **`model.json`** holds `format` (1), `name` (the file's name without `.p2lrt` until the owner
  renames it, a rename being one line of 1 to 64 characters), `kind` (`psd2live`), `file`
  (`model.p2lrt`), `size`, `sha256`, `importedAt` and `updatedAt`, then:
  - `inventory`, what the runtime read of the file: the version of the runtime that read it, the
    generator (`psd2live 3.8.4`), the canvas, the clips (id, name, group, duration, looping),
    expressions, hit areas, parameters with their ranges and defaults, parts, pose groups, whether
    a parameter has the LipSync role, and how many texture pages;
  - `framing`, `{call, companion}`, each a box of the rig's canvas or null for the SDK's default
    ([Framing and outfits](#framing-and-outfits));
  - `moods` and `gestures`, the owner's choices alone: a mood to up to two expression ids, a
    gesture to a clip id ([Moods](#moods));
  - `outfits`, up to 32, and `outfit`, the one she wears, or null.
- **The active model** is her `appearance.model` (`APPEARANCE_MODEL`), set through
  `PUT /api/local/settings` with `{"appearance.model": id}` for her persona, which refuses an id
  that names no model of hers (`invalid-setting`). While it is unset, or names a model she no
  longer has, she shows her avatar picture ([personas.md](personas.md#personayaml)). Removing a
  model clears her own `appearance.model` when it named it, never the environment's. A persona's
  summary and the status carry the active model's id, name, kind, `sha256` and `updatedAt` as
  `appearance.model`.

A rig PSD2Live generates carries standard names, which the SDK's defaults go by: the expressions
`smile`, `sad`, `angry` and `surprised`, plus `shy`, `sleepy` and `gloom` when the rig has their
parameters; the clips `Idle`, `Blink`, `Nod`, `Shake` and `Talk`; the hit areas `HitAreaHead` and
`HitAreaBody`; and the LipSync role on `ParamMouthOpenY`.

Importing one:

- **Only a `.p2lrt`**, recognized by its bytes (`P2LRT` and three NULs), whatever its name: an
  empty file is 400 `bad-request`, and anything else that doesn't start so is 415
  `unsupported-media-type`.
- **At most 200 MiB** (`MAX_MODEL_BYTES`, 209,715,200 bytes), counted as it streams: past that it is
  413 `payload-too-large`, and nothing is kept.
- **Loaded before it is kept.** The server runs the wasm the SDK ships (`psd2liveDir()`,
  `data/psd2live/` in the npm package), in a fresh instance for each upload: every chunk's CRC is
  checked, and every texture page must be a PNG inside the file, the kind the web player draws.
  What the runtime refuses is 400 `invalid-model` with its reason, such as `Chunk TEXR fails its
  CRC`, control characters stripped and at most 200 characters. A trap in the runtime ends that
  instance alone and is refused the same way.
- **An inventory of at most 1 MiB** (`INVENTORY_BYTES`), counting its text and 64 bytes an entry,
  about a hundred times the test rig's, since every list and status reads it back: a rig past it,
  which no export comes near, is 400 `invalid-model`, refused before the list or name that would
  pass it is read.
- **Never during a call** (409 `call-active`), for an import or a new file alike: loading a rig
  holds the server for a moment, which a call would hear.
- **Import never activates.** A new model has no settings of its own, and she shows what she showed
  before until the owner makes it hers.
- **A new file** for a model (`PUT …/:model/file`) passes the same checks and keeps the model's id,
  name and framing, and the moods, gestures and outfit entries that still name what the new file
  holds. Outfit values are clamped into the new ranges, and a mood left with none of its
  expressions goes back to its default.
- **The file** is served only under its current SHA-256 (`GET …/:model/file?sha256=`), as
  immutable, and only to the app's pages: it takes the session's cookie and proof, where her avatar
  picture takes the cookie alone. A browser keeps it for good, while the desktop app's page fetches
  it again on each full load; either page keeps it in memory for a minute once nothing shows it.

The routes, their answers and their errors are in [web-app.md](web-app.md#the-api).

## Studio's Appearance

The studio's **Appearance** section (形象), after Voice, holds **How She Looks** (她的形象), which
lists her models, and below it, once she has one, a card named after the model picked there, its
preview ([web-app.md](web-app.md)):

- **Import a Model**, or a file dropped on the card, uploads a `.p2lrt`; given a PSD2Live `web`
  export's folder or zip, it takes the `.p2lrt` out and leaves the rest, the export's `p2l.js` and
  wasm included. The card lists her models, with an **Active** badge on the one she shows. **Make
  Active** sets her `appearance.model`, with a hint while none is active, and **Model Options**
  holds Rename, Replace File and Remove, and Stop Using when clearing her own `appearance.model`
  would change what she shows.
- **The preview** draws the model on the SDK's stage, or her picture when it can't, with the tabs
  **Test**, **Framing**, **Moods** and **Outfits**, which edit one draft that Save sends:
  - **Test:** expression chips and clip buttons; **Try a Line**, which reads a pasted reply's
    direction and cues with the SDK's moods and plays them on the preview, billing nothing; **Use
    Microphone**, which moves her mouth through the mouth meter; and **Follow Pointer**.
  - **Framing** edits the call framing, a box of the rig's canvas, with the pointer and the wheel.
  - **Moods** sets the expressions each mood shows and the clip each gesture plays, and
    **Outfits** her outfits and the one she wears.
- **Under reduced motion** the preview plays no clip by itself, her idle included, while a clip
  played from the Test tab still plays.

## The SDK's avatar entry

`@laplace.live/eidolon-sdk/avatar` holds everything that draws and moves a model, as browser code
with no server half. Its API is in [client-sdk.md](client-sdk.md#avatars-eidolon-sdkavatar); this
is how the pieces fit:

```text
a call's events               → direct()       → DirectionState
the DirectionState            → directionOf()  → Direction      → stage.direct(direction)
an audio track                → MouthMeter                      → stage.mouth(meter)
the model and its model.json  → resolveSetup() → ResolvedSetup  → stage.show(model, setup)
each frame the stage applies what it was given to the model, then updates and draws it
```

- **The stage**, `AvatarStage`, owns a canvas's frame loop. Each frame it applies the latest
  direction (her idle clip, talking, gestures, expressions and gaze), reads the mouth, then updates
  and draws the model. A model that fails is disposed and reported once, so the page can show her
  picture instead.
- **The model adapter**, `AvatarModel`, is what the stage asks of a model: expressions, clips on
  three layers, the mouth, gaze, an outfit, bounds, hit tests, an alpha read, and update, draw and
  dispose. `loadPsd2liveModel` gives the PSD2Live one, on a runtime instance of its own, and
  `inspectPsd2liveRig` reads a file's inventory without WebGL.
- **`direct()`** is a pure reducer from a call's events to a `DirectionState`, from which
  `directionOf()` reads her `Direction`. Both are plain data, so the reducer can run where the call
  runs and what it gives cross a `MessagePort` to where she is drawn.
- **The moods:** `moodTags` reads a direction into mood tags, `soundCueEffect` a cue into a lent
  mood and a gesture, and `resolveSetup` turns a model's `moods` and `gestures` into what the stage
  plays.
- **The mouth:** `MouthMeter` reads an audio track's loudness through `mouthCurve` into a mouth
  opening.

## Direction and behaviors

`direct(state, event)` folds each of a call's events into a `DirectionState`, and
`directionOf(state, persona?)` reads her `Direction` from it: her mood and a cue's lent mood,
whether she speaks, listens or thinks, where she looks, and the latest gesture. Each event carries
`at`, milliseconds on any steady clock, and a `tick` every 100 ms or so lands the cues due by then
and ends lent moods. The stage applies the direction each frame:

- **Idle:** unless reduced motion is on, her `Idle` clip loops on clip layer 0 from the moment she
  is shown; PSD2Live's runtime blinks and breathes on its own either way.
- **Listening:** while the viewer speaks she looks at them. When they stop and their words have
  come in, she nods; words that arrive after they stopped earn the nod as they arrive, and a stop
  with no words earns none.
- **Thinking:** after that nod, and from `bot-llm-started` or a tool call (`function-call`), she
  thinks, looking up and to the side, until she speaks. She never looks away while she speaks.
- **Speaking** comes only from `bot-started-speaking` and `bot-stopped-speaking`, the events of her
  audio: a realtime model's text arrives after its audio, so her text never decides it. While she
  speaks, `Talk` loops on clip layer 1.
- **Her mood** comes from the `[direction]` her reply's first segment opens with, read by
  `moodTags` ([Moods](#moods)). A reply that opens with none is neutral, and its later segments keep
  its mood whatever they open with. The mood holds until her next reply, which starts at the first
  segment after the viewer's words (unless they came while she was still speaking, as a backchannel
  does), after an interruption, or after a group call's `speaker`; a `reset` starts over.
- **Cues** such as `[chuckling]` apply `soundCueEffect`: a mood lent over her reply's for 1.5 to 3
  seconds, and for a few a nod. A cue before the segment's first voiced letter lands as the segment
  starts (`new`). The others land as the words before them are heard: as `spoken` passes them for a
  voice that reports word timings, and otherwise at her pace, 4.5 voiced letters (letters and
  digits) a second from the segment's `new`, never later than its `completed`, which lands whatever
  is left. Fish, her default voice, reports no word timings: each segment comes as `new`, then
  `completed` once heard, so her pace times her cues.
- **An interruption** (`bot-interrupted`) ends her reply and drops the cues she never got to.
- **Gestures:** each new gesture plays once on clip layer 2, over her idle and her talking, which
  show through again as it ends; a looping clip picked for one plays a single pass.
- **A chat reply**, which no voice says (`reply`), sets her mood from its direction, and its cues
  land at her pace.
- **Group calls:** a `speaker` event sends the bot events after it to that persona, while the
  viewer's events reach everyone, so everyone nods. `directionOf(state, persona)` gives each
  persona's direction; without a persona it gives the speaking one's, or hers on a call with her
  alone.
- **Skipped:** word, token, backchannel and expression outputs, which repeat her sentences or sit
  outside her reply.
- **Gaze:** at the viewer, (0, 0), while she listens; up and to the side, (0.35, 0.45), drifting
  slowly, while she thinks; otherwise around the viewer, within 0.15 on each axis, moving every 2 to
  5 s (each axis -1..1, x right, y up). A page can instead have her follow the pointer or hold a
  point (`gaze()`).
- **Reduced motion** keeps her face, her mouth and where she looks, and the blinking and breathing
  the runtime does by itself, and leaves out every clip (idle, talking and gestures), the drift and
  the wandering eyes. A clip a page plays through `stage.model` still plays.

## Moods

`moodTags(direction)` reads a direction into at most two mood tags: each family below matches by its
Chinese keywords anywhere in the direction except right after a negation, and its English ones as
whole words, whatever their case, and a direction keeps the first two families it matches, in this
order. A negation is 不, 不是, 没, 没有 or 别, never the 别 of 特别, softened or not by 太, 大, 很,
怎么, 那么, 这么, 特别 or 再: 不开心 and 不太高兴 are never happy, and 一点都不害羞 never shy. A mood
shows its default expressions, the standard ids PSD2Live gives a generated rig:

| Mood | Chinese, anywhere | English, whole words | Shows |
| --- | --- | --- | --- |
| surprised | 惊, 意外, 没想到, 诧异, 愣住 | surprised, shocked, startled, amazed | `surprised` |
| thinking | 疑惑, 困惑, 摸不着头脑, 回忆, 想了想, 思考, 琢磨, 犹豫, 纳闷 | thinking, puzzled, pondering, curious | nothing |
| wry | 哭笑不得, 无奈, 无语, 叹气, 没好气, 好笑又, 又好笑 | wry, exasperated, resigned | `sad`, `smile` |
| shy | 害羞, 不好意思, 心虚, 脸红, 羞, 扭捏, 找补, 歉意 | shy, embarrassed, sheepish, bashful | `shy` |
| sad | 难过, 失落, 伤心, 委屈, 低落, 闷闷, 哽咽, 哭 (never inside 哭笑不得) | sad, hurt, sorrowful, crying | `sad` |
| angry | 生气, 恼火, 愤, 气呼呼, 不爽, 烦躁 | angry, annoyed, furious, irritated | `angry` |
| gloom | 阴沉, 阴阳, 冷笑, 阴森 | ominous, sinister, sarcastic | `gloom` |
| pout | 嘴硬, 嫌弃, 傲娇, 轻哼, 哼, 吐槽, 反驳, 理直气壮, 嘟囔 | pouting, defiant, tsundere | `angry` |
| lazy | 懒洋洋, 慵懒, 散漫, 漫不经心, 拖长音, 困 (never inside 困惑, 困扰 or 困难), 哈欠 | lazy, sleepy, drowsy, languid | `sleepy` |
| happy | 笑, 开心, 高兴, 欢快, 兴奋, 得意, 调侃, 起哄, 打趣, 轻快, 雀跃 | happy, cheerful, playful, teasing, excited, delighted | `smile` |
| gentle | 温柔, 轻柔, 软软, 哄, 安慰, 轻声 | gentle, soft, tender, warm, soothing | `smile` |

Of `prompt.md`'s published directions, 懒洋洋的，带点笑意 is lazy and happy, 嘴硬，装作嫌弃 pout,
温柔地安慰 gentle and 有点失落，慢慢地说 sad, while 压低声音，像在说悄悄话 tags none and leaves her
neutral. 哭笑不得 is wry and happy, never sad, and 困惑 is thinking, never lazy. Two moods show the
union of their expressions in tag order, at most two: lazy and happy show `sleepy` and `smile`, the
face that direction asks for. A cue's lent mood comes first, over the reply's.

**Cues.** `soundCueEffect` decides every cue the SDK's `CUE_EMOJI` knows. `chuckling` and `laughing`
lend happy for 1.5 s and nod; `sighing` lends wry for 2 s and `groaning` for 1.5 s; `gasping` and
`screaming` lend surprised for 1.5 s; `yawning` lends lazy for 2 s and `snoring` for 3 s; `sobbing`
and `crying loudly` lend sad for 3 s. Fish's emotion and tone cues lend their mood for 2 s
(`grateful` nods too), and `panting`, `determined`, `indifferent`, `in a hurry tone`, `shouting` and
`whispering` change nothing.

**A model's own choices.** `model.json`'s `moods` replaces a mood's defaults with up to two of the
model's expressions, an empty list showing none, and its `gestures` picks the clip `idle`, `talk`,
`nod` or `shake` plays. Without them a mood shows the defaults the rig has, and a gesture plays the
clip whose group, name or id, tried in that order and whatever their case, is `Idle`, `Talk`, `Nod`
or `Shake`: PSD2Live's editor names clip ids `modifier:m32:…` under the name and group `Idle`, so an
id alone finds nothing. An expression or clip id the rig lacks changes nothing, where the upstream
player's `-1` stopped the clip playing or faded every expression out.

**Coverage.** The table's first draft, ten families before gloom joined, tagged 85 of 88 (97%) of
the directions her replies opened with in the owner's local chats, two personas' and mostly text;
most took two families. Its tests hold `prompt.md`'s published directions and lines written in
their style, never lines from the owner's chats.

## Lip sync

Her mouth follows her voice's loudness. `MouthMeter` reads an audio track, such as a call's bot
track, through `createMediaStreamSource` into an `AnalyserNode` that reaches no speaker: an
`fftSize` of 1024, 21 ms at 48 kHz, read as float samples, since 8-bit ones quantize near -42 dBFS,
about where the curve begins. The stage reads it once a frame, and its RMS in dBFS runs through
`mouthCurve` into the rig's lip sync, the parameter its LipSync role names, every frame whether she
speaks or not. An `AudioContext` made outside a click starts suspended and reads silence, so a page
makes it in the click that starts the audio.

A plain loudness map holds the mouth open through connected speech, so each frame is also weighed
against the loudness around it. `MOUTH_CURVE`, in dBFS and seconds:

| Setting | Value | What it does |
| --- | --- | --- |
| `lo`, `hi` | -40, -10 | the loudness map: shut at `lo`, open at `hi`; below `lo` + 2 the mouth is shut outright |
| `peakWindow` | 0.25 | how far back a syllable's peak is remembered |
| `floorWindow` | 0.12 | how far back the dip before it is looked for |
| `minRange` | 10 | the narrowest swing read as a syllable, so a held vowel stays open |
| `base` | 0.1 | how open the mouth stays at a dip, as a share of the loudness map |
| `attack`, `release` | 0.02, 0.045 | the envelope's time constants, opening and closing |

Each frame's target is `loud × (base + (1 − base) × local)`: `loud` is the frame on the loudness
map, and `local` where it sits between the last 0.12 s's dip and the last 0.25 s's peak, over a
swing of at least 10 dB. The envelope then moves the mouth toward the target.

It was tuned on her own voice, never on synthetic speech alone. On her 12 Fish voice messages,
whose voiced frames span p10 -35, p50 -19 and p90 -9.4 dBFS, it shuts her mouth on 25% of voiced
frames and 1.5 times a second, where the loudness map alone closed it 0.46 times a second.
[Its benchmark](benchmarks/2026-11-23-mouth-curve/README.md) says what counts as voiced, shut and
a closure, and scores a change on her voice messages through the SDK's own `mouthCurve`. The tests
check its shape on synthetic voices: bursts with gaps, a tone whose loudness swings like syllables,
a steady vowel and silence.

## Framing and outfits

**Framing** works in boxes of the rig's canvas, in its pixels, y down.

- `bustBox(head, character)` frames a call: her head is 42% of the box's height and its centre 40%
  down, at a width of 4:5, centred on the head. With no head to go by it is the top third of her.
- `companionBox(character)` frames all of her, with 4% of her size around on each side.
- `viewFor(box, rig, element)` gives the player's view that shows the whole box, centred, in an
  element of a given CSS size. The stage recomputes it each frame from the canvas's size, and shows
  the whole canvas until `frame(box)` gives it a box.
- `panBox` and `zoomBox` edit a box as Studio's Framing tab does: a drag keeps what was under the
  pointer under it, and a zoom keeps its anchor in place.

A model's `framing.call` of null takes `bustBox` of its `HitAreaHead`'s bounds, and
`framing.companion` of null takes `companionBox` of every mesh drawn.

**Outfits** are drawn from what the rig already holds. An outfit shows pose entries (one entry of
each pose group it names, the others fading out), holds parameters at a value through the
runtime's override layer, over clips and expressions, and hides parts. Taking it off lets the
parameters go, shows the parts again and puts each pose group back on the entry it showed at load.
The server checks each outfit against the model's inventory: entries its pose groups have,
parameters within their ranges and parts the rig has, each named once.

## Rendering

- **One runtime instance per model.** The wasm is compiled once per URL, from its bytes, and each
  model gets an instance of its own, so a trap ends only that model and its memory goes with it.
- **WebGL 1**, on the canvas the page gives the stage, in premultiplied alpha, with a stencil for
  masks. `renderer.ts` draws as PSD2Live's runtime header lays down: blend modes, isolated groups
  drawn into layers, and masks. Texture pages are decoded with `createImageBitmap`, premultiplied
  and without color conversion. 32-bit mesh indices come from `OES_element_index_uint`; without it,
  a model with a mesh past 65,535 vertices is refused as `webgl`.
- **The drawing buffer** follows the canvas's CSS size times the device pixel ratio, capped at
  `maxPixelRatio` (2), and is resized as a draw finds it changed. `fps` caps the frame rate (0, the
  default, draws every animation frame), and a frame steps her by at most 0.1 s, so a stalled tab
  resumes without a jump.
- **Paused** while the page is hidden, while an IntersectionObserver says the canvas is off screen,
  and after `pause()`.
- **Hit tests and alpha reads:** `hitTest` gives the hit area under a point of the page, and
  `alphaAt` the drawn alpha there, read right after the next draw, before the page composites the
  frame and the drawing buffer is cleared.
- **Errors** are `AvatarError`s: `runtime` (the runtime didn't load or compile, as under a CSP
  without `'wasm-unsafe-eval'`), `rig` (the file isn't a rig it reads, or a texture page didn't
  decode), `webgl` (no WebGL, or a shader that didn't compile), `lost` (the browser took the context
  back) and `trap` (the runtime failed while running). The stage disposes a model that throws, or
  whose context is lost, and reports it once; the app then shows her picture.

## The vendored runtime

`packages/sdk/src/avatar/psd2live/wasm/p2l_runtime.wasm` is PSD2Live's committed build of its
`runtime/` at
[`f66ba4611d81154a35715c721539e912ad10d7f9`](https://github.com/tsunehimatoi/psd2live/tree/f66ba4611d81154a35715c721539e912ad10d7f9)
(release 3.8.4), byte for byte: the file every PSD2Live `web` export carries, 629,677 bytes,
SHA-256 `d8bbff52f27aebd40baca94139f9eca5af0f9d2a07c1c70fc5c15633121862a7`. It has 130 exports and
no imports, so it reaches nothing but its own memory; at that commit its ABI is 1.4 and
`p2l_version` answers `0.1.0`. Beside it, `LICENSE` is PSD2Live's `runtime/LICENSE`, and
`THIRD_PARTY_LICENSES.md` holds the licenses of the crates compiled into it (miniz_oxide, adler2,
ruzstd, twox-hash).

- **The ABI check:** the page and the server alike run it only at ABI 1.2 or a later 1.x: 1.2
  brought clip layers with priorities, several expressions at once and lip sync. The page checks
  `PSD2LIVE_ABI` and refuses another as `AvatarError` `runtime`; the server's upload check holds
  its own copy of that minimum, in `apps/bot/src/local/psd2live.ts`.
- **The player** is ported, not vendored: `rig.ts` holds the half of PSD2Live's `p2l.js` that runs
  without WebGL and `renderer.ts` the half that draws, keeping upstream's method order so a refresh
  diffs cleanly.
- **Where it ships:** the SDK's pack copies the folder to `dist/avatar/wasm/`, beside the bundle
  whose `new URL("./wasm/p2l_runtime.wasm", import.meta.url)` names it, which a bundler such as Vite
  resolves and ships with the page; the local app serves `.wasm` as `application/wasm`. The npm
  package ships the folder as `data/psd2live/`, where the server finds it through `psd2liveDir()`,
  and the desktop app's payload takes it from there.
- **Refreshing** follows [its README](../packages/sdk/src/avatar/psd2live/README.md): copy the
  newer commit's wasm and update every test that pins its SHA-256 (`git grep d8bbff52`), port
  upstream's `p2l.js` diff into `rig.ts` and `renderer.ts`, put the new commit wherever the old one
  is named (`git grep f66ba46`), the SDK's `THIRD_PARTY.md` and AGENTS.md included, copy the
  licenses, and check `PSD2LIVE_ABI`, and the server's minimum in `apps/bot/src/local/psd2live.ts`,
  against `runtime/include/p2l_runtime.h`.

PSD2Live's spec for `.p2lrt` 2 adds features only as new chunks: the runtime skips an optional
chunk it doesn't know and refuses a required one by its tag. A model that needs a newer runtime is
therefore refused at import, as `invalid-model` with that reason, and a refresh is what lets it in.

## Testing

- **The SDK** (`bun run test packages/sdk`), on Node with no browser:
  - `avatar-direct.test.ts` scripts a call's events as each kind of voice sends them: Fish, with no
    progress; a voice with word timings; a realtime model, whose segments arrive after its audio;
    and group calls.
  - `avatar-moods.test.ts` reads `prompt.md`'s published directions and lines written in their
    style, never lines from the owner's chats, and decides every cue in `CUE_EMOJI`.
  - `avatar-mouth.test.ts` pins `MOUTH_CURVE` and checks it on synthetic voices;
    [its benchmark](benchmarks/2026-11-23-mouth-curve/README.md) scores it on her voice messages.
  - `avatar-framing.test.ts`, and `avatar-stage.test.ts`, which drives the stage with a fake model
    and a clock the test moves.
  - `avatar-psd2live.test.ts` runs the vendored runtime on the test rig: its SHA-256, exports and
    ABI; the rig's inventory; clips found by group; lip sync; two expressions at once; ids it lacks;
    the head's bounds and a hit test; and refusals with the runtime's reasons.
  - `parity.test.ts` holds `inspectPsd2liveRig`'s inventory equal to the server's upload check on
    the test rig, and `build.test.ts` the pack: the avatar bundle, the wasm's SHA-256, the license
    files, every asset its bundle names, and a Node import that reads the rig with the packed wasm.
- **The server** (`bun run test apps/bot/test/local`): `psd2live.test.ts` checks the upload check on
  the test rig, on PNG and zip bytes, on a cut-off file, a flipped byte inside a chunk and a changed
  version, on a texture page that isn't a PNG inside the file, and on rigs it rewrites past the
  inventory's 1 MiB, a long name within it kept whole; `appearance.test.ts` the ids, the
  folder an import makes, the 200 MiB limit declared and streamed, the call refusal, the active
  model, every route, and ids that try to leave their folder. `static.test.ts` pins the CSP, its
  `'wasm-unsafe-eval'` included, and the wasm's type.
- **The browser smoke** (`bun apps/bot/scripts/local-smoke.ts`,
  [web-app.md](web-app.md#the-browser-smoke-test)) imports the test rig in the studio's Appearance,
  checks its preview draws under the app's CSP, that Use Microphone closes its audio while the
  browser still asks for the microphone, that a stage made anew ends a line tried on it, and that a
  mood put back while its Save is out stays put back, refuses a PNG and a cut-off rig, and makes the
  model active, then stops using it.
- **The npm package:** `ci-install-check.ts` imports the test rig into the packed server on Linux
  and Windows CI, which proves the upload check finds its runtime under `EIDOLON_APP_ROOT`, and the
  package's and the desktop stage's tests hold `data/psd2live/` in place.
- **The test rig**, `apps/bot/test/local/fixtures/psd2live/tml.p2lrt`, is the CC0 `tml` character
  from psd2live-examples as PSD2Live 3.8.4's editor exports it: 3,471,396 bytes, six 1024² texture
  pages, zstd-compressed chunks, the clips `Idle`, `Blink`, `Nod`, `Shake` and `Talk` (each its
  name and its group, with the ids `modifier:m32:…` to `modifier:m36:…`), the seven standard
  expressions, `HitAreaHead` and `HitAreaBody`, and a 2048² canvas. Its README says where it came
  from. The production image leaves its folder out, and the SDK's tests read it by path.

## Measured

On 2026-11-23, before the port, with PSD2Live's own `p2l.js` and the same wasm in a page served
with the app's CSP plus `'wasm-unsafe-eval'`, on an Apple silicon Mac at 120 Hz, in Chrome and in
Electron 45.4.1 (Chromium 156), on CC0 rigs exported by PSD2Live 3.8.4's command line:

- **The CSP:** the app's policy without `'wasm-unsafe-eval'` refused the runtime with a
  `CompileError` naming `script-src 'self' blob:`. With it, the runtime ran in Chrome and in
  Electron, through a privileged custom scheme standing in for `eidolon-app://`.
- **Speed:** one model ran at 120 fps, a frame's `update` taking 0.41 ms on average (p95 1.1) and
  its draw 0.21 ms of CPU. Three side by side also ran at 120 fps, 0.1 + 0.06 ms each.
- **Loading:** compiling the wasm took 2–4 ms; the rig and GL setup about 280–300 ms cold, most of
  it shader compiles (26 ms in a second window); the textures 42–54 ms.
- **Memory:** 10.6 MB of wasm memory per model, and a JS heap of 5.6 MB with one model, 13 MB with
  three.
- **CPU in Electron:** the GPU process 1.2%, a page drawing at 120 fps 0.8%, and one capped at 30
  fps 0.4% (0.33 + 0.16 ms a frame).
- **The server's check:** the same wasm loads a rig under Node 24 and Bun 1.4.5, compiling in 1–2 ms
  and loading in 8–20 ms, with no browser.
- **Bad files** failed cleanly, with no trap: `Not a .p2lrt rig`, `Chunk TEXR lies outside the
  file`, `Non-zero padding before an array`.
- **Behaviors:** all seven standard expressions showed, and two at once worked: `sleepy` with
  `smile` is 懒洋洋的，带点笑意's face. `Talk` on layer 1 and `Nod` on layer 2 played over `Idle`,
  the gaze turned her head and body, a hit test at the head's centre gave `HitAreaHead`, and a bust
  framed from that hit area's bounds worked. A pose group set at export switched with `showPose`,
  fading her headwear out, and setting a part's opacity to 0 hid it.
- **Lip sync:** the mouth followed loudness with no lag. Her voice messages span p10 -35, p50 -19
  and p90 -9.4 dB, where macOS's `say` is flatter (p25 -23, p90 -15): a first map of -50…-18 dB held
  her mouth wide open, and -40…-8 dB put her median near 0.64, but through connected speech the
  mouth still rarely shut between syllables. The curve's peak and dip windows
  ([Lip sync](#lip-sync)) are what shut it there.
- **Exports:** a command-line export took about 4.7 s and 1.5 GB of memory. `tml.p2lrt` was 4.4 MB,
  3.6 MB with zstd, about half of it its one 4096² PNG page: a 2048² canvas, 25 meshes, 4,011
  vertices, 7 parts, 78 parameters, `Idle` a 12 s loop and `Talk` 6 s.
