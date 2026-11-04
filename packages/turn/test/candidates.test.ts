import { describe, expect, test } from "bun:test";
import {
  candidateReachable,
  dropUnreachableCandidates,
  scrubRelayRelatedAddresses,
} from "../src/index.ts";

const HOST_LAN = "a=candidate:1 1 udp 2122260223 192.168.1.20 54400 typ host generation 0";
const HOST_CGNAT =
  "a=candidate:2 1 udp 2122194687 100.101.102.103 54401 typ host generation 0 network-id 2";
const HOST_MDNS =
  "a=candidate:3 1 udp 2122129151 c0ffee00-1234-4abc-9def-0123456789ab.local 54402 typ host generation 0";
const SRFLX =
  "a=candidate:4 1 udp 1685987071 8.8.4.4 54403 typ srflx raddr 0.0.0.0 rport 0 generation 0";
const RELAY =
  "a=candidate:5 1 udp 41885439 104.30.1.2 3478 typ relay raddr 8.8.4.4 rport 46243 generation 0";
const MALFORMED = "a=candidate:1 1 udp";

function offer(candidates: readonly string[], eol = "\r\n"): string {
  const lines = [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    ...candidates,
    "a=ice-ufrag:abcd",
    "a=ice-pwd:0123456789abcdefghijklmn",
    "a=fingerprint:sha-256 AB:CD:EF",
    "a=setup:actpass",
    "a=mid:0",
    "a=rtpmap:111 opus/48000/2",
  ];
  return lines.join(eol) + eol;
}

describe("candidateReachable", () => {
  test("PATCH candidates, with or without the a= prefix", () => {
    expect(candidateReachable(HOST_LAN.slice(2))).toBe(false);
    expect(candidateReachable(HOST_LAN)).toBe(false);
    expect(candidateReachable(HOST_CGNAT.slice(2))).toBe(false);
    expect(candidateReachable(HOST_MDNS.slice(2))).toBe(false);
    expect(candidateReachable(SRFLX.slice(2))).toBe(true);
    expect(candidateReachable(RELAY.slice(2))).toBe(true);
  });

  test("the end-of-candidates marker and unparseable lines pass", () => {
    expect(candidateReachable("")).toBe(true);
    expect(candidateReachable("a=end-of-candidates")).toBe(true);
    expect(candidateReachable("candidate:1 1 udp 2122260223 192.168.1.20 54400 typ")).toBe(true);
    expect(candidateReachable(MALFORMED)).toBe(true);
  });

  test("tokens split on any whitespace, as pipedog's candidateFromSdp does", () => {
    expect(candidateReachable("candidate:1\t1  udp 2122260223 10.0.0.2 9 typ host\r\n")).toBe(
      false,
    );
    expect(candidateReachable(" candidate:1 1 udp 2122260223 8.8.8.8 9 typ host")).toBe(true);
    expect(candidateReachable("candidate: 1 1 udp 2122260223 10.0.0.2 9 typ host")).toBe(false);
  });

  test("IPv6 addresses", () => {
    const v6 = (address: string) => `candidate:7 1 udp 2122262783 ${address} 54404 typ host`;
    expect(candidateReachable(v6("2606:4700:4700::1111"))).toBe(true);
    expect(candidateReachable(v6("fe80::1%en0"))).toBe(false);
    expect(candidateReachable(v6("fd7a:115c:a1e0::1"))).toBe(false);
    expect(candidateReachable(v6("::ffff:192.168.1.1"))).toBe(false);
  });
});

describe("dropUnreachableCandidates", () => {
  test("drops LAN, CGNAT and mDNS hosts; keeps everything else byte for byte", () => {
    const keep = [SRFLX, RELAY, MALFORMED, "a=end-of-candidates"];
    const sdp = offer([HOST_LAN, HOST_CGNAT, HOST_MDNS, ...keep]);
    const result = dropUnreachableCandidates(sdp);
    expect(result.dropped).toEqual([
      "192.168.1.20",
      "100.101.102.103",
      "c0ffee00-1234-4abc-9def-0123456789ab.local",
    ]);
    expect(result.sdp).toBe(offer(keep));
    expect(result.sdp.endsWith("a=rtpmap:111 opus/48000/2\r\n")).toBe(true);
    expect(result.sdp.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
  });

  test("an SDP without candidates comes back unchanged", () => {
    const sdp = offer([]);
    expect(dropUnreachableCandidates(sdp)).toEqual({ sdp, dropped: [] });
    expect(dropUnreachableCandidates("")).toEqual({ sdp: "", dropped: [] });
  });

  test("LF-only SDP keeps LF", () => {
    const result = dropUnreachableCandidates(offer([HOST_LAN, RELAY], "\n"));
    expect(result).toEqual({ sdp: offer([RELAY], "\n"), dropped: ["192.168.1.20"] });
  });

  test("a dropped last line without a line ending leaves the previous line's intact", () => {
    const result = dropUnreachableCandidates(`${RELAY}\r\n${HOST_LAN}`);
    expect(result).toEqual({ sdp: `${RELAY}\r\n`, dropped: ["192.168.1.20"] });
  });

  test("only a=candidate lines are filtered", () => {
    const sdp = `${HOST_LAN.slice(2)}\r\nb=${HOST_LAN.slice(2)}\r\n`;
    expect(dropUnreachableCandidates(sdp)).toEqual({ sdp, dropped: [] });
  });
});

describe("scrubRelayRelatedAddresses", () => {
  const RELAY_ANSWER =
    "a=candidate:4069387340 1 udp 16777215 104.30.5.6 54321 typ relay raddr 203.0.113.7 rport 61000 generation 0 ufrag abcd\r";
  const SCRUBBED =
    "a=candidate:4069387340 1 udp 16777215 104.30.5.6 54321 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag abcd\r";

  test("rewrites a relay candidate's raddr and rport", () => {
    expect(scrubRelayRelatedAddresses(RELAY_ANSWER)).toBe(SCRUBBED);
    expect(scrubRelayRelatedAddresses(SCRUBBED)).toBe(SCRUBBED);
  });

  test("leaves host, srflx and every non-candidate line alone", () => {
    const host = "a=candidate:1 1 udp 2130706431 172.17.0.2 40000 typ host generation 0";
    const srflx =
      "a=candidate:2 1 udp 1694498815 198.51.100.4 40000 typ srflx raddr 172.17.0.2 rport 40000";
    const other = "a=rtcp:9 IN IP4 0.0.0.0";
    const sdp = [host, srflx, other, "a=end-of-candidates", ""].join("\r\n");
    expect(scrubRelayRelatedAddresses(sdp)).toBe(sdp);
  });

  test("a relay candidate without raddr is untouched", () => {
    const line = "a=candidate:5 1 udp 41885439 104.30.1.2 3478 typ relay generation 0 ufrag abcd";
    expect(scrubRelayRelatedAddresses(line)).toBe(line);
  });

  test("a whole answer: IPv6 and TCP relays, CRLF kept", () => {
    const answer = [
      "v=0",
      "o=- 1 0 IN IP4 0.0.0.0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 0.0.0.0",
      RELAY_ANSWER.slice(0, -1),
      "a=candidate:2 1 udp 16777215 2606:4700::6810:1 54322 typ relay raddr 2001:db8::7 rport 61001 generation 0",
      "a=candidate:3 1 tcp 16777215 104.30.5.6 54323 typ relay raddr 203.0.113.7 rport 61002 tcptype passive",
      "a=end-of-candidates",
      "",
    ].join("\r\n");
    expect(scrubRelayRelatedAddresses(answer)).toBe(
      [
        "v=0",
        "o=- 1 0 IN IP4 0.0.0.0",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "c=IN IP4 0.0.0.0",
        SCRUBBED.slice(0, -1),
        "a=candidate:2 1 udp 16777215 2606:4700::6810:1 54322 typ relay raddr 0.0.0.0 rport 0 generation 0",
        "a=candidate:3 1 tcp 16777215 104.30.5.6 54323 typ relay raddr 0.0.0.0 rport 0 tcptype passive",
        "a=end-of-candidates",
        "",
      ].join("\r\n"),
    );
  });

  test("only the raddr and rport attribute values change", () => {
    const line =
      "a=candidate:raddr 1 udp 1 104.30.5.6 2 typ relay rport 7 raddr 203.0.113.7 ufrag raddr";
    expect(scrubRelayRelatedAddresses(line)).toBe(
      "a=candidate:raddr 1 udp 1 104.30.5.6 2 typ relay rport 0 raddr 0.0.0.0 ufrag raddr",
    );
    const noRelated =
      "a=candidate:1 1 udp 1 104.30.5.6 2 typ relay generation 0 ufrag raddr network-id 3";
    expect(scrubRelayRelatedAddresses(noRelated)).toBe(noRelated);
  });
});
