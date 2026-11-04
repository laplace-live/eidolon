import { expect, test } from "bun:test";
import * as imagegen from "../src/index.ts";

// The signatures apps/bot and runtime compile against; this file stops type-checking if one drifts.
const contract: {
  SELFIE_PATH: "/api/selfie";
  SelfieStore: new (options?: {
    now?: () => number;
    newId?: () => string;
  }) => {
    publish(image: imagegen.GeneratedImage, ttlSeconds: number): string;
    lookup(segment: string): imagegen.GeneratedImage | null;
  };
  selfieStore: imagegen.SelfieStore;
  selfieResponse: (segment: string, store?: imagegen.SelfieStore) => Response;
} = imagegen;

test("the pinned exports are live", () => {
  expect(contract.SELFIE_PATH).toBe("/api/selfie");
  expect(contract.selfieStore).toBeInstanceOf(imagegen.SelfieStore);
  expect(contract.selfieResponse("missing").status).toBe(404);
});
