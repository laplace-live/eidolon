import { relayCanReach } from "./address.ts";

const SDP_CANDIDATE = "a=candidate:";
const CANDIDATE_PREFIX = /^(a=)?candidate:/;
const LINE = /(?<=\n)/;

// RFC 8839: foundation component transport priority address port "typ" type, then name/value
// pairs. pipedog's candidateFromSdp tokenizes the same way and refuses fewer than 8 tokens.
function tokens(candidate: string): string[] {
  return candidate.replace(CANDIDATE_PREFIX, "").trim().split(/\s+/);
}

/** The connection address, or null for a line shorter than pipedog's parser accepts. */
function candidateAddress(candidate: string): string | null {
  const bits = tokens(candidate);
  return bits.length < 8 ? null : (bits[4] as string);
}

/**
 * Whether a relay could reach a `candidate:` / `a=candidate:` line's address.
 *
 * True for `""`, the end-of-candidates marker, which must always pass. Also true for a line too
 * short to parse, so the parser downstream rejects it as it would have without the filter.
 */
export function candidateReachable(candidate: string): boolean {
  const address = candidateAddress(candidate);
  return address === null || relayCanReach(address);
}

/** The SDP without candidates a relay cannot reach, and their addresses in order. */
export function dropUnreachableCandidates(sdp: string): { sdp: string; dropped: string[] } {
  const dropped: string[] = [];
  const kept: string[] = [];
  // Each piece keeps its own line ending, so CRLF survives and a dropped line takes its own.
  for (const line of sdp.split(LINE)) {
    const address = line.startsWith(SDP_CANDIDATE) ? candidateAddress(line) : null;
    if (address !== null && !relayCanReach(address)) dropped.push(address);
    else kept.push(line);
  }
  return { sdp: kept.join(""), dropped };
}

function scrubLine(line: string): string {
  if (!line.startsWith(SDP_CANDIDATE)) return line;
  // Tokens sit at even indices and the whitespace between them at odd ones, so rejoining keeps
  // every byte that is not a rewritten value.
  const pieces = line.slice(SDP_CANDIDATE.length).split(/(\s+)/);
  const at: number[] = [];
  for (let i = 0; i < pieces.length; i += 2) if (pieces[i] !== "") at.push(i);
  if (at.length < 8 || pieces[at[7] as number] !== "relay") return line;
  for (let t = 8; t + 1 < at.length; t += 2) {
    const name = pieces[at[t] as number];
    if (name === "raddr") pieces[at[t + 1] as number] = "0.0.0.0";
    else if (name === "rport") pieces[at[t + 1] as number] = "0";
  }
  return SDP_CANDIDATE + pieces.join("");
}

/**
 * Every `typ relay` candidate's raddr/rport rewritten to 0.0.0.0/0.
 *
 * werift fills a relay candidate's raddr/rport with the TURN server's XOR-MAPPED-ADDRESS, which
 * is our public IP. Browsers accept 0.0.0.0 0 there.
 */
export function scrubRelayRelatedAddresses(sdp: string): string {
  return sdp.split(LINE).map(scrubLine).join("");
}
