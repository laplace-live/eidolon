import { logger } from "@eidolon/config";
import type { OpusCodec } from "@pipedog/transport-smallwebrtc/opus";

/**
 * `base` with every encoder at `bitrateBps`. pipedog's sender builds each Opus encoder through
 * its connection's codec with a fixed 96 kbps, so this is the seam for the session's preset. A
 * renegotiation keeps the connection's codec, so changing audioQuality mid-session needs a
 * reconnect. libopus-wasm keeps the `voip` application, as aiortc did: better speech timbre
 * than `audio` at equal bitrate.
 */
export function opusCodecAtBitrate(base: OpusCodec, bitrateBps: number): OpusCodec {
  return {
    createEncoder(options) {
      logger.debug(`[WebRTC] Opus encoder constructed at ${Math.floor(bitrateBps / 1000)} kbps`);
      return base.createEncoder({ ...options, bitrate: bitrateBps });
    },
    createDecoder(options) {
      return base.createDecoder(options);
    },
  };
}
