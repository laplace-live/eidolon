# Mouth curve — 2026-11-23

Her mouth follows her voice's loudness through `MOUTH_CURVE` (`packages/sdk/src/avatar/mouth.ts`,
[avatar.md](../../avatar.md#lip-sync)). A plain loudness map holds the mouth open through connected
speech, so the curve also weighs each frame against the last 0.25 s's peak and the last 0.12 s's
dip, which shuts it between syllables. This benchmark scores a curve on her own voice; the SDK's
tests check only its shape, on synthetic voices.

## What it scores

`score.ts` decodes each file with ffmpeg to 48 kHz mono and reads it as `MouthMeter` reads a call
at 60 fps: the RMS of the last 1024 samples, every 800 samples, through the SDK's own `loudnessOf`
and `mouthCurve`.

- **A voiced frame** is louder than -45 dBFS.
- **Shut** is an opening below 0.2.
- **A closure** is the opening falling below 0.2 after it rose above 0.45, counted per second of the
  frames read, 60 to a second, silences included.

It prints the voiced frames' p10, p50 and p90, then for `MOUTH_CURVE` and for the loudness map alone
(-40 to -8 dBFS, opening in 35 ms and closing in 90 ms, as Phase 0 left it) the share of voiced
frames shut and the closures a second, each averaged over the files.

## Her voice

On 2026-11-23, on her 12 Fish voice messages in the owner's chats (milky-green), whose voiced frames
span p10 -34.8, p50 -19.4 and p90 -9.4 dBFS:

| Curve | Voiced frames shut | Closures a second |
| --- | ---: | ---: |
| `MOUTH_CURVE` | 25% | 1.52 |
| The loudness map alone | 7% | 0.46 |

## Reproduce

From the repository root, with ffmpeg on PATH:

```sh
node docs/benchmarks/2026-11-23-mouth-curve/score.ts <her voice messages>…
```

Her voice messages are the audio of her `message` events with `modality: "voice"` in the owner's
chats: the first attachment of each, an MP3 in `<data home>/chats/<chat id>/files/`
([chat.md](../../chat.md#the-local-store-jsonlchatstore)). They are the owner's conversations, so
reading them waits for the owner's go-ahead, and only the numbers are written down here, never the
files. A change to `MOUTH_CURVE` is scored before and after on the same files.
