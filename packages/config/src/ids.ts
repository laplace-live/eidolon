import { v7 } from "uuid";

/** A UUID v7: time-ordered, and monotonic within a millisecond. */
export function newId(): string {
  return v7();
}
