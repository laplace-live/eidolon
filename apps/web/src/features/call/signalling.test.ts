import { afterEach, expect, test, vi } from "vitest";
import { EXPECTED_HOST_HEADER, PROOF_HEADER } from "../../../../bot/src/local/api.ts";
import {
  resetExpectedSubspaceHost,
  setExpectedSubspaceHost,
  subscribeExpectedHostConflict,
} from "../../lib/api";
import { keepProof } from "../../lib/proof";
import { fetchIceServers, offerOptions } from "./signalling";

afterEach(() => {
  resetExpectedSubspaceHost();
  vi.restoreAllMocks();
});

test("the offer goes with the session's proof, which the server needs beside the cookie", () => {
  keepProof("proof-for-the-offer");
  const options = offerOptions();
  expect(options.endpoint).toBe("/api/offer");
  expect(new Headers(options.headers).get(PROOF_HEADER)).toBe("proof-for-the-offer");
  expect(options.requestData).toEqual({ audioQuality: "medium" });
});

test("a call inside a chat names the chat and whom it calls there", () => {
  keepProof("proof-for-a-chat-call");
  const options = offerOptions({ chatId: "0199-chat", persona: "mio" });
  expect(options.endpoint).toBe("/api/offer");
  expect(new Headers(options.headers).get(PROOF_HEADER)).toBe("proof-for-a-chat-call");
  expect(options.requestData).toEqual({
    audioQuality: "medium",
    chatId: "0199-chat",
    persona: "mio",
  });
});

test("the ICE servers are asked for with the proof too, and an empty list is an answer", async () => {
  keepProof("proof-for-ice");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ iceServers: [] }));
  expect(await fetchIceServers()).toEqual([]);
  const [to, init] = fetch.mock.calls[0] ?? [];
  expect([to, init?.credentials, new Headers(init?.headers).get(PROOF_HEADER)]).toEqual([
    "/api/ice-servers",
    "same-origin",
    "proof-for-ice",
  ]);
});

test("call signalling pins X-Eidolon-Expected-Host when set and notifies on 409 ICE conflict", async () => {
  keepProof("proof-pinned");
  setExpectedSubspaceHost("srv_call_1");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ iceServers: [] }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "conflict" } }), { status: 409 }),
    );

  const options = offerOptions();
  expect(new Headers(options.headers).get(EXPECTED_HOST_HEADER)).toBe("srv_call_1");
  await fetchIceServers();
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get(EXPECTED_HOST_HEADER)).toBe(
    "srv_call_1",
  );

  // An explicit captured expectedHost remains pinned even after global active host switches.
  setExpectedSubspaceHost("srv_call_2");
  expect(new Headers(offerOptions(undefined, "srv_call_1").headers).get(EXPECTED_HOST_HEADER)).toBe(
    "srv_call_1",
  );

  const onConflict = vi.fn();
  const unsubscribe = subscribeExpectedHostConflict(onConflict);
  try {
    await expect(fetchIceServers("srv_call_1")).rejects.toThrow("HTTP 409");
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get(EXPECTED_HOST_HEADER)).toBe(
      "srv_call_1",
    );
    expect(onConflict).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});
