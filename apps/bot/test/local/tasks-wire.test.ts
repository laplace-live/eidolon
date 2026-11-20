// api.ts can't import @eidolon/assistant or @eidolon/engine, so it mirrors the task snapshot and
// the transcript entries the routes send: the typecheck fails here once a mirror drifts.
import type { TaskEntry } from "@eidolon/engine";
import { expect, test } from "vitest";
import type { TaskSnapshot } from "../../../../packages/assistant/src/index.ts";
import type {
  TaskEntry as WireTaskEntry,
  TaskSnapshot as WireTaskSnapshot,
} from "../../src/local/api.ts";

/** Every field required, at every depth, so an optional field only one side has differs too. */
type Filled<T> = T extends object ? { [K in keyof T]-?: Filled<T[K]> } : T;

type Same<A, B> = [A, Filled<A>] extends [B, Filled<B>]
  ? [B, Filled<B>] extends [A, Filled<A>]
    ? true
    : false
  : false;

test("the wire's task snapshot and transcript entries are the stored ones", () => {
  const snapshot: Same<TaskSnapshot, WireTaskSnapshot> = true;
  const entry: Same<TaskEntry, WireTaskEntry> = true;
  expect([snapshot, entry]).toEqual([true, true]);
});
