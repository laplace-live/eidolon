// An account's own voices as React Query keeps them, through real observers: what a list shows
// while its next search loads, and when it asks Fish again.
import { focusManager, InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { AccountVoicesResponse, Voice } from "@/lib/api";
import { linguiMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
const { ownVoicesQuery } = await import("./queries");

const page = (...ids: string[]): AccountVoicesResponse => ({
  status: "ok",
  total: ids.length,
  totalIsExact: true,
  hasMore: false,
  items: ids.map((id) => ({ id }) as Voice),
});

const clients: QueryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.unmount();
    client.clear();
  }
  focusManager.setFocused(undefined);
});

/** An observer on `account`'s list as `q` searches it, over a Fish that never answers. */
function observe(client: QueryClient, account: string, q: string) {
  const queryFn = vi.fn(() => new Promise<AccountVoicesResponse>(() => {}));
  const observer = new InfiniteQueryObserver(client, {
    ...ownVoicesQuery(account, q, ""),
    queryFn,
  });
  return { observer, queryFn, unsubscribe: observer.subscribe(() => {}) };
}

/** A client that listed fish's voices `age` ms ago. */
function listed(age: number): QueryClient {
  const client = new QueryClient();
  client.mount();
  clients.push(client);
  client.setQueryData(
    ownVoicesQuery("fish", "", "").queryKey,
    { pages: [page("a")], pageParams: [1] },
    { updatedAt: Date.now() - age },
  );
  return client;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a list keeps its rows while its next search loads, but never another account's", () => {
  const { observer, unsubscribe } = observe(listed(0), "fish", "");
  observer.setOptions({
    ...ownVoicesQuery("fish", "mg", ""),
    queryFn: () => new Promise(() => {}),
  });
  expect(observer.getCurrentResult()).toMatchObject({
    isPlaceholderData: true,
    data: { pages: [page("a")] },
  });
  observer.setOptions({
    ...ownVoicesQuery("fish-2", "mg", ""),
    queryFn: () => new Promise(() => {}),
  });
  expect(observer.getCurrentResult()).toMatchObject({ isPlaceholderData: false, data: undefined });
  unsubscribe();
});

test("a list asks Fish again when it is shown 30 s after it was listed, and not sooner", async () => {
  for (const [age, asks] of [
    [29_000, 0],
    [31_000, 1],
  ] as const) {
    const { queryFn, unsubscribe } = observe(listed(age), "fish", "");
    await settle();
    expect([age, queryFn.mock.calls.length]).toEqual([age, asks]);
    unsubscribe();
  }
});

test("coming back to the window asks Fish again, however soon", async () => {
  const { queryFn, unsubscribe } = observe(listed(0), "fish", "");
  await settle();
  expect(queryFn).not.toHaveBeenCalled();
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await settle();
  expect(queryFn).toHaveBeenCalledTimes(1);
  unsubscribe();
});
