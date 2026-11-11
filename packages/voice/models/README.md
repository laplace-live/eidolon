# The models

The two ONNX models the Ear runs on onnxruntime-node 1.30.0, as pipedog 0.10.0's
`@pipedog/audio-silero` and `@pipedog/audio-smart-turn` shipped them, byte for byte. Each is the
file Pipecat ships. `THIRD_PARTY_LICENSES.md` holds their licenses.

| File | What | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `silero_vad.onnx` | Silero VAD (MIT) | 2,327,524 | `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3` |
| `smart-turn-v3.2-cpu.onnx` | Smart Turn v3.2, int8-quantized for the CPU (BSD-2-Clause, Daily; fine-tuned from Whisper Tiny, Apache-2.0) | 8,679,182 | `2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f` |

`voiceModels()` (`src/models.ts`) finds them through `voiceModelsDir()` from `@eidolon/config`,
never relative to the code. The npm package ships the folder as `data/models/`.
