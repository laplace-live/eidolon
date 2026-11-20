import { expect, test } from "vitest";
import { newId } from "../src/index.ts";

test("newId is a UUID v7, in the order made even within a millisecond", () => {
  const ids = Array.from({ length: 100_000 }, () => newId());
  expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.toSorted()).toEqual(ids);
  // Its first 48 bits are the time it was made, in ms.
  const made = Number.parseInt((ids.at(-1) as string).replace("-", "").slice(0, 12), 16);
  expect(Math.abs(made - Date.now())).toBeLessThan(60_000);
});
