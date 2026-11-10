// A native call's WebRTC on werift and libopus-wasm, with no pipedog. Only packages/runtime
// imports it.
export { AUDIO_IN_RATE, AudioIn, type AudioPacket } from "./audio_in.ts";
export { AudioOut, type PcmSource } from "./audio_out.ts";
export { AudioJitterBuffer, type AudioJitterOutput, type JitterPacket } from "./jitter.ts";
export {
  libopusWasmCodec,
  OPUS_RTP_CLOCK_RATE,
  type OpusCodec,
  type OpusDecoder,
  type OpusDecoderOptions,
  type OpusEncoder,
  type OpusEncoderOptions,
  opusCodecAtBitrate,
  opusPacketSamples,
} from "./opus.ts";
export {
  type CandidateRules,
  closeWhenDtlsCloses,
  type DtlsClosable,
  TURN_CANDIDATE_RULES,
} from "./patches.ts";
export {
  candidateFromSdp,
  candidateToSdp,
  type IceCandidate,
  Peer,
  type PeerCall,
  type PeerOptions,
  peerCallTransport,
} from "./peer.ts";
export {
  createSignallingServerWith,
  HttpError,
  type PeerPlan,
  peerPlan,
  type SignallingDeps,
  type SignallingResult,
  type SignallingServer,
} from "./signalling.ts";
