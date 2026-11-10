import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { reread } from "./reread";

/** An observed query whose first read waits for `release` and answers "stale"; later ones "fresh". */
function slowFirstRead() {
  const client = new QueryClient();
  const queryKey = ["chats", "a"];
  let reads = 0;
  let release = () => {};
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: async () => {
      reads++;
      if (reads > 1) return "fresh";
      await first;
      return "stale";
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  return { client, queryKey, release, reads: () => reads, unsubscribe };
}

describe("reread", () => {
  test("an invalidation alone gets the first read in flight, which may predate the stream", async () => {
    const { client, queryKey, release, reads, unsubscribe } = slowFirstRead();
    const invalidated = client.invalidateQueries({ queryKey });
    release();
    await invalidated;
    expect(client.getQueryData(queryKey)).toBe("stale");
    expect(reads()).toBe(1);
    unsubscribe();
  });

  test("reads once more after a first read still in flight", async () => {
    const { client, queryKey, release, reads, unsubscribe } = slowFirstRead();
    const done = reread(client, queryKey);
    release();
    await done;
    expect(client.getQueryData(queryKey)).toBe("fresh");
    expect(reads()).toBe(2);
    unsubscribe();
  });

  test("reads once when the query already has data", async () => {
    const { client, queryKey, release, reads, unsubscribe } = slowFirstRead();
    release();
    await client.refetchQueries({ queryKey });
    await reread(client, queryKey);
    expect(client.getQueryData(queryKey)).toBe("fresh");
    expect(reads()).toBe(2);
    unsubscribe();
  });
});
