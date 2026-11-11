// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/test/test_smallwebrtc_request_handler.test.ts@ce8f8bc
//
// PATCH /api/offer's candidates. Firefox emits an RFC 8840 end-of-candidates marker per media line:
// a real RTCIceCandidate whose `.candidate` string is empty. That can't be parsed as a candidate,
// and addIceCandidate takes `null`, not an empty-string candidate, as the end of candidates: the
// server forwards `null` for an empty marker instead of failing or dropping it.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AllowedOffer } from "@eidolon/access";
import { type IceCandidate, Peer } from "../src/peer.ts";
import { createSignallingServerWith, type SignallingServer } from "../src/signalling.ts";

const REAL_CANDIDATE_SDP = "candidate:0 1 UDP 2121990399 192.168.1.1 35628 typ host";

const OFFER = {
  allowed: true,
  user: { mid: null, uname: null, face: null, isLoggedIn: false },
  token: null,
  body: { sdp: "v=0", type: "offer" },
  requestData: null,
  opusBitrateBps: 96000,
  clientIp: "127.0.0.1",
  quota: null,
} as AllowedOffer;

describe("TestHandlePatchRequest", () => {
  let server: SignallingServer;
  let pcId: string;
  let added: (IceCandidate | null)[];
  let restore: () => void;

  beforeEach(async () => {
    added = [];
    const spies = [
      spyOn(Peer.prototype, "initialize").mockImplementation(async () => {}),
      spyOn(Peer.prototype, "getAnswer").mockImplementation(function (this: Peer) {
        return { sdp: "v=0\r\n", type: "answer", pc_id: this.pcId };
      }),
      spyOn(Peer.prototype, "addIceCandidate").mockImplementation(async (candidate) => {
        added.push(candidate);
      }),
    ];
    restore = () => {
      for (const spy of spies) spy.mockRestore();
    };
    server = createSignallingServerWith(
      {
        ice: {
          serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }),
        },
      },
      { startSession: async () => {} },
    );
    pcId = ((await server.offer(OFFER)).body as { pc_id: string }).pc_id;
  });

  afterEach(async () => {
    restore();
    await server.close();
  });

  const patch = (candidates: readonly [string, string, number][]) =>
    server.patch(
      JSON.stringify({
        pc_id: pcId,
        candidates: candidates.map(([candidate, sdp_mid, sdp_mline_index]) => ({
          candidate,
          sdp_mid,
          sdp_mline_index,
        })),
      }),
    );

  test("test_empty_candidate_forwarded_as_none", async () => {
    // A single empty-string marker becomes a `null` candidate, not an error.
    expect(await patch([["", "0", 0]])).toEqual({ status: 200, body: { status: "success" } });
    expect(added).toEqual([null]);
  });

  test("test_mixed_real_and_empty_candidates_across_mids", async () => {
    // Real candidates parse normally; empty markers become `null`, matching Firefox's batch of
    // real candidates followed by a per-mid end-of-candidates marker for audio (mid 0), video
    // (mid 1), and data (mid 3).
    await patch([
      [REAL_CANDIDATE_SDP, "0", 0],
      ["", "0", 0],
      [REAL_CANDIDATE_SDP, "1", 1],
      ["", "1", 1],
      ["", "3", 3],
    ]);
    expect(added).toHaveLength(5);
    for (const [candidate, expectedMid, expectedMline] of [
      [added[0], "0", 0],
      [added[2], "1", 1],
    ] as const) {
      expect(candidate).not.toBeNull();
      expect(candidate?.sdpMid).toEqual(expectedMid);
      expect(candidate?.sdpMLineIndex).toEqual(expectedMline);
    }
    for (const candidate of [added[1], added[3], added[4]]) expect(candidate).toBeNull();
  });
});
