import { v7 } from "uuid";

/** A UUID v7: time-ordered, and monotonic within a millisecond, as Bun.randomUUIDv7 was. */
export function newId(): string {
  return v7();
}
