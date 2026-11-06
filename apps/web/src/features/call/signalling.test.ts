import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { PROOF_HEADER } from "../../../../bot/src/local/api.ts";
import { keepProof } from "../../lib/proof";
import { fetchIceServers, offerRequest } from "./signalling";

afterEach(() => {
  mock.restore();
});

test("the offer goes with the session's proof, which the server needs beside the cookie", () => {
  keepProof("proof-for-the-offer");
  const request = offerRequest();
  expect(request.endpoint).toBe("/api/offer");
  expect(request.headers?.get(PROOF_HEADER)).toBe("proof-for-the-offer");
  expect(request.requestData).toEqual({ audioQuality: "medium" });
});

test("the ICE servers are asked for with the proof too, and an empty list is an answer", async () => {
  keepProof("proof-for-ice");
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ iceServers: [] }));
  expect(await fetchIceServers()).toEqual([]);
  const [to, init] = fetch.mock.calls[0] ?? [];
  expect([to, new Headers(init?.headers).get(PROOF_HEADER)]).toEqual([
    "/api/ice-servers",
    "proof-for-ice",
  ]);
});
