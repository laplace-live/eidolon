# Selfies

The `take_selfie` tool: the viewer asks to see a photo, the bot redraws its
reference image through OpenRouter's image route and the picture appears on
their screen mid-call.

On by default. The references are whatever images sit in
`data/selfie-references/`, which the Dockerfile ships along with the rest of
`data/`, so a deployment needs no configuration — drop a file in to give the
model another view of the character, empty the directory and the tool stops
being registered. `SELFIE_REFERENCE_IMAGES` overrides the set; every env var
it reads is documented in `.env.example`.

## The shape of it

```text
viewer: "拍张自拍给我看看"
  → LLM calls take_selfie (no arguments)
  → handler runs OpenRouterImageGenService.run_image_gen(built-in prompt)
  → POST https://openrouter.ai/api/v1/images  { prompt, input_references }
  → bytes land in a TTL store, served at GET /api/selfie/<id>.png
  → RTVIServerMessageFrame { type: "selfie", urls: [...] } → client
  → the LLM gets { ok: true } and says something about it
```

`image_generation.py` owns all of it. `laplace-generate-image` calls the same
`generate()`, so what you probe from the CLI is what a viewer gets.

## Why the service is not in the pipeline

Pipecat's `ImageGenService` is the official base class, and
`OpenRouterImageGenService` subclasses it in the ordinary way —
`run_image_gen(prompt)` yielding one `URLImageRawFrame` per image.

But its inherited `process_frame` generates an image from **every `TextFrame`
it sees**, which is the right trigger for a prompt→image bot and exactly wrong
here: this pipeline streams one `TextFrame` per sentence on the way to TTS.
Adding the service to `Pipeline([...])` would bill an image per sentence
spoken. So it is constructed but never placed; the tool handler drives
`run_image_gen` directly. Keep it that way.

## Why the image travels as a URL

The generated PNG is ~1 MB, ~1.4 MB once base64'd. RTVI messages ride the
WebRTC data channel, whose SCTP messages are capped far below that, so an
inline data URL would not arrive. Instead the bytes go in a process-local TTL
store and the RTVI message carries only `/api/selfie/<id>.png`.

The id is the whole authorization — unguessable, single-purpose, and expiring
— so the route needs no session of its own. The path is relative because the
client is same-origin with `/api/offer`; nothing has to know the public
hostname.

The alternative was `video_out_enabled=True` on the transport, pushing the
frame to a video track. That adds a video track to every call, including the
ones that never ask for a photo, to deliver one still image. The frame the
service yields is a real `URLImageRawFrame` with decoded pixels, so that route
stays open if it is ever wanted.

Because the store is process-local, a deployment that ever runs more than one
worker needs shared storage here — a second worker will 404 on the first
worker's ids.

## Why the call is asynchronous

`register_function(..., cancel_on_interruption=False)` makes the tool call
asynchronous in Pipecat's sense: the LLM continues the conversation
immediately rather than holding the turn, and the result is injected later as
a developer message. A render takes ten-odd seconds, and a voice bot that goes
silent that long sounds broken. The persona prompt tells it to say something
like 等我一下 on the way out, and the schema description tells it not to read
the URL aloud.

`timeout_secs` (`SELFIE_TIMEOUT_SECONDS`, 120 by default) bounds it. The httpx
timeout behind it is deliberately much longer, for the CLI's benefit.

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

`SELFIE_PROMPT` in `image_generation.py`, not `persona.md` — it describes a
drawing, not the persona. It carries two slots, `{time}` and `{light}`, filled
by `fill_time()` from the persona's timezone (`PERSONA_TIMEZONE`), so a selfie
taken at 23:00 is lit by a lamp against a dark window. Substitution is
`str.replace`, not `str.format`, so a brace in an edited prompt can't raise.

## Friends

`data/selfie-references/friends/` holds one image per person the persona can
be photographed with, **named after them** — `七海Nana7mi.png` becomes the
enum value `七海Nana7mi`. Adding someone is dropping a file in; nothing else
knows their name. The directory is skipped by `reference_sources()` (it only
takes files), so friends never leak into a solo shot.

The tool takes a `with_friends` array whose enum is exactly those names, and
the model is told to fill it only when it actually knows — from memory or the
current conversation — that it is out with them. A name it invents anyway is
dropped with a warning rather than reaching the prompt, since there would be
no reference image to draw that person from.

Naming anyone also moves the scene outdoors: a group selfie in the persona's
own room reads as odd, so `build_selfie_prompt` swaps `{setting}` and takes
the hour's *outdoor* lighting from `_AMBIENCE` instead of its indoor one.
The friends' references are appended after the persona's own, which is the
order the prompt tells the model to expect.

To see what a change actually produces, without a WebRTC call:

```bash
uv run laplace-generate-image -o /tmp/out.png
uv run laplace-generate-image --friend 七海Nana7mi -o /tmp/group.png
```

With no arguments it uses the same bundled references and the same built-in
prompt the bot does; `--friend` exercises the group path the same way a tool
call does. It prints the filled prompt, then writes the image.
