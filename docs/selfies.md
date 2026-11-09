# Selfies

The `take_selfie` tool: the viewer asks to see a photo, the bot redraws its
reference image through OpenRouter's image route and the picture appears on
their screen mid-call.

On by default. The references live in the persona's `references/` folder: her
template ships `outfits/`, and `friends/` lives in the data home's copy of her
folder, never in the repository (see [personas.md](personas.md)). The two
merge by file name, the data home's copy winning, so a deployment needs no
configuration — drop an outfit in `outfits/` and it becomes selectable, empty
both and the tool stops being registered. `SELFIE_REFERENCE_IMAGES` overrides
the set; every env var it reads is documented in `.env.example`.

## The shape of it

```text
viewer: "拍张自拍给我看看"
  → LLM calls take_selfie (no arguments)
  → the tool runs renderSelfie(built-in prompt), which calls generate()
  → POST https://openrouter.ai/api/v1/images  { prompt, input_references }
  → bytes land in a TTL store, served at GET /api/selfie/<id>.png
  → RTVI server message { type: "selfie", urls: [...] } → client
  → the LLM gets { ok: true } and says something about it
```

`packages/imagegen` owns the prompt, the references, the request and the
store; the tool itself is `packages/tools/src/selfie.ts`.
`laplace-generate-image` calls the same `generate()`, so what you probe from
the CLI is what a viewer gets.

## Why no image service is in the pipeline

pipedog's `ImageGenService` is the framework's base class for image
generation: a subclass implements `runImageGen(prompt)`. But its inherited
`processFrame` generates an image from **every `TextFrame` it sees**, which is
the right trigger for a prompt→image bot and exactly wrong here: this pipeline
streams one `TextFrame` per sentence on the way to TTS. An image service in
the pipeline would bill an image per sentence spoken. So none is placed there;
the tool calls `renderSelfie` directly. Keep it that way.

## Why the image travels as a URL

The generated PNG is ~1 MB, ~1.4 MB once base64'd. RTVI messages ride the
WebRTC data channel, whose SCTP messages are capped far below that, so an
inline data URL would not arrive. Instead the bytes go in a process-local TTL
store (`SelfieStore`, `packages/imagegen/src/store.ts`) and the RTVI message
carries only `/api/selfie/<id>.png`.

The id is the whole authorization — unguessable, single-purpose, and expiring
— so the route needs no session of its own. The path is relative because the
client is same-origin with `/api/offer`; nothing has to know the public
hostname.

The alternative was a video track on the transport, pushing the image to it.
That adds a video track to every call, including the ones that never ask for a
photo, to deliver one still image.

Because the store is process-local, a deployment that ever runs more than one
worker needs shared storage here — a second worker will 404 on the first
worker's ids.

## Why the call is asynchronous

The tool's `cancelOnInterruption: false` makes pipedog run the call
asynchronously: the LLM continues the conversation immediately rather than
holding the turn, and the result is injected later as a developer message. A
render takes ten-odd seconds, and a voice bot that goes silent that long sounds
broken. The persona prompt tells it to say something like 等我一下 on the way
out, and the schema description tells it not to read the URL aloud.

`timeoutSecs` (`SELFIE_TIMEOUT_SECONDS`, 120 by default) bounds it. The
request's own idle timeout (`IMAGE_REQUEST_IDLE_TIMEOUT_MS`, 600 s) is
deliberately much longer, for the CLI's benefit: a max-quality render runs for
minutes.

## The frontend side

The wire contract is one `server-message`:

```jsonc
{ "type": "selfie", "urls": ["/api/selfie/<id>.png"] }
```

Paths are root-relative so the bot never has to know its own public
hostname; the client prefixes them with the same base it derives from its
`/api/offer` URL, which keeps a custom-backend override pointing at that
backend's images. They expire — render them, don't persist them.

The `laplace` web client implements this in `ai-chat-content.tsx`'s
`RTVIEvent.ServerMessage` handler, which injects the picture into the
transcript as a ReactNode message part and mirrors the newest one into the
call overlay (the overlay covers the transcript, and a selfie lands exactly
when the viewer is watching it). See
[frontend-loading-state.md](frontend-loading-state.md) for the rest of the
RTVI event surface.

## The prompt

`SELFIE_PROMPT` in `packages/imagegen/src/prompt.ts`, not `prompt.md` — it
describes a drawing, not the persona. It carries two slots, `{time}` and
`{light}`, filled by `fillTime()` from the persona's timezone
(`PERSONA_TIMEZONE`), so a selfie taken at 23:00 is lit by a lamp against a
dark window. Substitution is plain string replacement, never a template
engine, so a brace in an edited prompt can't break it.

## Outfits are mutually exclusive

Two directories, two rules:

```text
personas/milky-green/references/
  outfits/   one character, different outfits — exactly one per render
    day.png
    night.png
  friends/   one image per person — all of them, all at once (data home only)
    七海Nana7mi.png
```

`outfits/day.png` and `outfits/night.png` are the same character dressed
differently, not two views of one outfit, and the model cannot tell the
difference: given both, it reads the second as a second person. A group selfie
with one friend came back with three people in frame, the extra one wearing the
other outfit.

So `selectOutfit` lets exactly one through, and `referenceSources` is the only
way to reach it (`packages/imagegen/src/references.ts`) — the bot and
`laplace-generate-image` both go through there, so neither can put her in frame
twice. The hour picks which: `night.png` during the hours `AMBIENCE` calls
`night` and `late night` (21:00–05:00, `AFTER_DARK`), `day.png` otherwise, so
the outfit and the light the prompt asks for agree. Selection happens per
render, not at startup, or a bot booted in daylight would still be wearing the
day outfit at 03:00.

Adding a third outfit needs no code — it's selectable immediately, and `night`
in the file name is the whole convention. Loose images sitting directly in
`references/` are read as outfits too, which is the layout from before
`outfits/` existed.

None of these names reach a model. References travel as base64 `data:` URLs,
so the file names are for the code and for whoever reads this — only
`friends/` stems become model-visible, as the `with_friends` enum.

To force one, name it explicitly — that path bypasses the clock:

```bash
bun run laplace-generate-image -i personas/milky-green/references/outfits/night.png
```

## Friends

`references/friends/` holds one image per person the persona can
be photographed with, **named after them** — `七海Nana7mi.png` becomes the
enum value `七海Nana7mi`. Adding someone is dropping a file in; nothing else
knows their name. `referenceSources()` reads `outfits/` and never this
directory, so friends can't leak into a solo shot.

The tool takes a `with_friends` array whose enum is exactly those names, and
the model is told to fill it only when it actually knows — from memory or the
current conversation — that it is out with them. A name it invents anyway is
dropped with a warning rather than reaching the prompt, since there would be
no reference image to draw that person from.

Naming anyone also moves the scene outdoors: a group selfie in the persona's
own room reads as odd, so `buildSelfiePrompt` swaps `{setting}` and takes
the hour's *outdoor* lighting from `AMBIENCE` instead of its indoor one.
The friends' references are appended after the persona's own, which is the
order the prompt tells the model to expect.

To see what a change actually produces, without a WebRTC call:

```bash
bun run laplace-generate-image -o /tmp/out.png
bun run laplace-generate-image --friend 七海Nana7mi -o /tmp/group.png
```

With no arguments it uses the same bundled references and the same built-in
prompt the bot does; `--friend` exercises the group path the same way a tool
call does. It prints the filled prompt, then writes the image.
