import type { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

export interface NetworkInfo {
  /** `host`, `srflx`, `prflx`, or `relay`. */
  readonly localCandidateType?: string;
  readonly remoteCandidateType?: string;
  readonly localAddress?: string;
  readonly remoteAddress?: string;
  /** `udp` or `tcp`. */
  readonly protocol?: string;
  /** Protocol used to reach the TURN server on a `relay` candidate. */
  readonly relayProtocol?: string;
  /** Most recent RTT measurement in seconds. */
  readonly currentRoundTripTime?: number;
  readonly bytesSent?: number;
  readonly bytesReceived?: number;
}

interface ExtendedCandidatePairStats extends RTCIceCandidatePairStats {
  selected?: boolean;
}

interface CandidateStat extends RTCStats {
  candidateType?: string;
  protocol?: string;
  relayProtocol?: string;
  address?: string;
  ip?: string;
}

/** Reads `SmallWebRTCTransport`'s unexported `pc` field when an `RTCPeerConnection` is open. */
export function readPeerConnection(transport: SmallWebRTCTransport): RTCPeerConnection | null {
  if (typeof RTCPeerConnection === "undefined") return null;
  const value: unknown = Reflect.get(transport, "pc");
  return value instanceof RTCPeerConnection ? value : null;
}

/** Projects the active ICE candidate pair from `pc.getStats()` into `NetworkInfo`. */
export async function gatherNetworkInfo(pc: RTCPeerConnection): Promise<NetworkInfo | null> {
  const stats = await pc.getStats();

  let selectedPairId: string | undefined;
  let pair: ExtendedCandidatePairStats | undefined;
  for (const stat of stats.values()) {
    if (!selectedPairId && stat.type === "transport") {
      const transportStat: RTCTransportStats = stat;
      if (typeof transportStat.selectedCandidatePairId === "string") {
        selectedPairId = transportStat.selectedCandidatePairId;
      }
    } else if (!pair && stat.type === "candidate-pair" && stat.state === "succeeded") {
      const candidatePair: ExtendedCandidatePairStats = stat;
      if (candidatePair.nominated || candidatePair.selected) pair = candidatePair;
    }
  }
  if (selectedPairId !== undefined) {
    const fromTransport: ExtendedCandidatePairStats | undefined = stats.get(selectedPairId);
    if (fromTransport !== undefined) pair = fromTransport;
  }
  if (!pair) return null;

  const localCand: CandidateStat | undefined = stats.get(pair.localCandidateId);
  const remoteCand: CandidateStat | undefined = stats.get(pair.remoteCandidateId);

  return {
    localCandidateType: localCand?.candidateType,
    remoteCandidateType: remoteCand?.candidateType,
    localAddress: localCand?.address ?? localCand?.ip,
    remoteAddress: remoteCand?.address ?? remoteCand?.ip,
    protocol: localCand?.protocol,
    relayProtocol: localCand?.relayProtocol,
    currentRoundTripTime: pair.currentRoundTripTime,
    bytesSent: pair.bytesSent,
    bytesReceived: pair.bytesReceived,
  };
}
