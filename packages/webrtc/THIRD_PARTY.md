# Third-party notices

`@eidolon/webrtc` ports pipedog's SmallWebRTC transport, under the BSD 2-Clause License in
`LICENSE-pipedog`; pipedog is a TypeScript port of Daily's Pipecat. It runs on werift (MIT) and
libopus-wasm (MIT, with libopus under BSD-3-Clause), installed as packages with their own notices.

It ports none of the aiortc-derived code in pipedog's transport: its jitter buffer is pipedog's own
`AudioJitterBuffer`, not aiortc's `JitterBuffer`, and it keeps no `TimestampMapper`.
