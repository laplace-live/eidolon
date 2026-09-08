# Live WebRTC verification

One anonymous call completed through the application's actual `/api/offer` route,
`bot()` entry point, and `SmallWebRTCTransport`. An aiortc peer sent the existing
16 kHz synthetic question as real-time Opus/RTP and received the spoken reply.
The HTTP response was 200; the peer connected, received 1,449 audio RTP packets
with zero reported inbound loss, and played out one complete answer into the
captured audio file.

For the full question `你平时最喜欢吃什么呀？`, context frame 611:

| Observation | Result |
| --- | --- |
| Embedding function calls | 1 |
| Embedding HTTP requests | 1, HTTP 200 |
| Vector dimension | 3,072 |
| Persona facts | 30 candidates, 8 returned results |
| Stream archive | 15 candidates, 3 returned results |
| Reranking | Both searches enabled; 2 HTTP requests, both 200 |
| Search execution | Persona facts, then archive, sequential |
| Vector identity | Identical float32 SHA-256 in both hybrid-search calls |
| Complete retrieved context forwarded | Both results inserted before LLM |

The embedding took 2.151 s; facts search including embedding took 3.721 s,
archive search took 1.806 s, and combined retrieval took 5.528 s. This is one
provider-latency sample, not a comparison with the prior benchmark. The received
reply became audible 14.889 s after the source audio ended.

Soniox split the opening name into the transcription `耐力。`, followed by the
full question. The three-character first fragment skipped both retrieval services
and initiated an LLM request that was immediately interrupted when the remaining
transcription arrived. The full question then made the single embedding request
reported above and received a complete answer. There were two LLM request starts
over the one audio call, one interrupted and one completed. No second call was run.

The server reported 63 lost inbound packets in remote RTCP statistics; the peer
reported zero loss for the received answer. This and the segmented transcription
limit timing comparisons but do not affect the directly observed embedding count.

The harness uses an in-process Uvicorn server and actual network WebRTC peers on
this machine. It overrides only the in-process ICE resolver to return no servers,
so the peers use host candidates; `.env` and runtime transport files were not
changed. This verifies the real audio transport and pipeline, but does not test
TURN, WAN, a browser, microphones, or speakers. It omits RTVI client-ready to avoid
a separate greeting turn. The user is anonymous, so Mem0 is skipped.

Artifacts:

- `webrtc-call.json`: timestamped pipeline/API/RTP observations; no SDP or credentials.
- `webrtc-reply.wav`: 9.6-second excerpt of the received 48 kHz stereo audio, starting
  19.3 seconds into the raw receive capture; FFprobe verified format and duration.
- `webrtc_call.py`: executable harness, writing raw results into
  `/tmp/eidolon-embedding-call-validation/` when run from this checkout.

The harness observes frame flow and wraps retrieval/API functions to record calls;
no search inputs, result scoring, reranker behavior, LLM settings, TTS settings, or
runtime configuration were changed for the test. Raw initial receive silence was
omitted from the saved audio excerpt.
