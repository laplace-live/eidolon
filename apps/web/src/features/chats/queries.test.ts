import type { ChatEvent } from "@eidolon/chat";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatContents, LocalChatSummary } from "@/lib/chats";
import { type MountedRoot, mountFakeDom } from "@/test/fake-dom";
import { linguiMacro } from "@/test/lingui-macro";

let listImpl: (signal?: AbortSignal) => Promise<readonly LocalChatSummary[]> = async () => [];
let readImpl: (id: string, signal?: AbortSignal) => Promise<ChatContents>;
let markImpl: (id: string, seq: number) => Promise<void> = async () => {};

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@/lib/chats", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chats")>("@/lib/chats");
  return {
    ...actual,
    listChats: (signal?: AbortSignal) => listImpl(signal),
    readChat: (id: string, signal?: AbortSignal) => readImpl(id, signal),
    markChatRead: (id: string, seq: number) => markImpl(id, seq),
  };
});

const { chatQuery, chatsQuery, useMarkRead } = await import("./queries");

const CHAT_ID = "01900000-0000-7000-8000-000000000001";
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const msg = (seq: number, kind: "user" | "persona", text: string): ChatEvent => ({
  seq,
  at: 1000 + seq,
  type: "message",
  id: `e${seq}`,
  speaker: kind === "user" ? { kind: "user" } : { kind: "persona", id: "milky-green" },
  text,
});

const summary = (lastSeq: number, unread: number): LocalChatSummary => ({
  id: CHAT_ID,
  title: null,
  participants: ["milky-green"],
  createdAt: 1000,
  updatedAt: 1000 + lastSeq,
  lastText: "hi",
  lastSeq,
  unread,
  active: false,
});

const contents = (events: readonly ChatEvent[]): ChatContents =>
  ({
    header: {
      format: 1,
      id: CHAT_ID,
      createdAt: 1000,
      participants: ["milky-green"],
    },
    events,
    lateTools: [],
    hearingRefusal: null,
    missingCallKeys: [],
    call: null,
    groupCall: false,
    defaultDisplay: "normal",
    defaultPermissions: "ask",
  }) as ChatContents;

function Harness({ id }: { readonly id: string }) {
  useQuery(chatsQuery);
  const chat = useQuery(chatQuery(id));
  useMarkRead(id, chat.data?.events, !chat.isFetching && !chat.isError);
  return null;
}

describe("useMarkRead", () => {
  let mounted: MountedRoot | null = null;
  let client: QueryClient | null = null;

  afterEach(async () => {
    if (client !== null) {
      client.unmount();
      client.clear();
      client = null;
    }
    if (mounted !== null) {
      const current = mounted;
      mounted = null;
      await current.unmount();
    }
  });

  test("waits for readChat to settle instead of posting stale cached events on reopen", async () => {
    const read = deferred<ChatContents>();
    const marked: Array<{ id: string; seq: number }> = [];
    listImpl = async () => [summary(3, 2)];
    readImpl = () => read.promise;
    markImpl = async (id, seq) => {
      marked.push({ id, seq });
    };

    client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchIntervalInBackground: false } },
    });
    client.setQueryData(chatsQuery.queryKey, [summary(3, 2)]);
    client.setQueryData(chatQuery(CHAT_ID).queryKey, contents([msg(1, "user", "hi")]));

    mounted = await mountFakeDom(
      createElement(QueryClientProvider, { client }, createElement(Harness, { id: CHAT_ID })),
    );
    await mounted.act(settle);

    expect(marked).toEqual([]);
    expect(client.getQueryData(chatsQuery.queryKey)?.[0]?.unread).toBe(2);

    await mounted.act(async () => {
      read.resolve(
        contents([msg(1, "user", "hi"), msg(2, "persona", "a"), msg(3, "persona", "b")]),
      );
      await settle();
    });

    await vi.waitFor(() => {
      expect(marked).toEqual([{ id: CHAT_ID, seq: 3 }]);
      expect(client!.getQueryData(chatsQuery.queryKey)?.[0]?.unread).toBe(0);
    });
  });

  test("cancels an in-flight chats poll and refreshes after markChatRead settles", async () => {
    const stalePoll = deferred<readonly LocalChatSummary[]>();
    const mark = deferred<void>();
    let pollCalls = 0;
    let pollAborted = false;
    let serverUnread = 2;
    listImpl = (signal) => {
      pollCalls += 1;
      if (pollCalls === 1) {
        signal?.addEventListener("abort", () => {
          pollAborted = true;
        });
        return stalePoll.promise;
      }
      return Promise.resolve([summary(3, serverUnread)]);
    };
    readImpl = async () =>
      contents([msg(1, "user", "hi"), msg(2, "persona", "a"), msg(3, "persona", "b")]);
    markImpl = () => mark.promise;

    client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchIntervalInBackground: false } },
    });
    client.setQueryData(chatsQuery.queryKey, [summary(3, 2)]);

    mounted = await mountFakeDom(
      createElement(QueryClientProvider, { client }, createElement(Harness, { id: CHAT_ID })),
    );
    await mounted.act(settle);

    await vi.waitFor(() => {
      expect(pollAborted).toBe(true);
    });
    stalePoll.resolve([summary(3, 2)]);
    await mounted.act(settle);
    expect(client.getQueryData(chatsQuery.queryKey)?.[0]?.unread).toBe(0);

    serverUnread = 0;
    mark.resolve();
    await mounted.act(settle);

    await vi.waitFor(() => {
      expect(pollCalls).toBe(2);
      expect(client!.getQueryData(chatsQuery.queryKey)?.[0]?.unread).toBe(0);
    });
  });

  test("refreshes chats if a poll started while markChatRead was in flight", async () => {
    const read = deferred<ChatContents>();
    const mark = deferred<void>();
    const midPoll = deferred<readonly LocalChatSummary[]>();
    let pollCalls = 0;
    let serverUnread = 2;
    listImpl = () => {
      pollCalls += 1;
      if (pollCalls === 1) return Promise.resolve([summary(3, 2)]);
      if (pollCalls === 2) return midPoll.promise;
      return Promise.resolve([summary(3, serverUnread)]);
    };
    readImpl = () => read.promise;
    markImpl = () => mark.promise;

    client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchIntervalInBackground: false } },
    });
    mounted = await mountFakeDom(
      createElement(QueryClientProvider, { client }, createElement(Harness, { id: CHAT_ID })),
    );
    await mounted.act(settle);
    await vi.waitFor(() => {
      expect(pollCalls).toBe(1);
    });

    await mounted.act(async () => {
      read.resolve(
        contents([msg(1, "user", "hi"), msg(2, "persona", "a"), msg(3, "persona", "b")]),
      );
      await settle();
    });
    await vi.waitFor(() => {
      expect(client!.getQueryData(chatsQuery.queryKey)?.[0]?.unread).toBe(0);
    });

    // Trigger a list poll while POST /read is still in flight.
    void client.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
    await mounted.act(async () => {
      serverUnread = 0;
      mark.resolve();
      await settle();
    });

    midPoll.resolve([summary(3, 2)]);
    await mounted.act(settle);

    await vi.waitFor(() => {
      expect(pollCalls).toBe(3);
      expect(client!.getQueryData(chatsQuery.queryKey)?.[0]?.unread).toBe(0);
    });
  });

  test("handles an in-flight initial chats load without erroring and refreshes after markChatRead", async () => {
    const initialPoll = deferred<readonly LocalChatSummary[]>();
    let pollCalls = 0;
    let serverUnread = 1;
    listImpl = () => {
      pollCalls += 1;
      if (pollCalls === 1) return initialPoll.promise;
      return Promise.resolve([summary(2, serverUnread)]);
    };
    readImpl = async () => contents([msg(1, "user", "hi"), msg(2, "persona", "a")]);
    markImpl = async () => {
      serverUnread = 0;
    };

    client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchIntervalInBackground: false } },
    });
    mounted = await mountFakeDom(
      createElement(QueryClientProvider, { client }, createElement(Harness, { id: CHAT_ID })),
    );
    await mounted.act(settle);

    expect(client.getQueryState(chatsQuery.queryKey)?.status).toBe("pending");

    await mounted.act(async () => {
      initialPoll.resolve([summary(2, 1)]);
      await settle();
    });

    await vi.waitFor(() => {
      expect(pollCalls).toBe(2);
      expect(client!.getQueryData(chatsQuery.queryKey)?.[0]?.unread).toBe(0);
    });
  });

  test("retries markChatRead while the chat stays open after a transient failure", async () => {
    vi.useFakeTimers();
    try {
      let markCalls = 0;
      let serverUnread = 2;
      listImpl = async () => [summary(3, serverUnread)];
      readImpl = async () =>
        contents([msg(1, "user", "hi"), msg(2, "persona", "a"), msg(3, "persona", "b")]);
      markImpl = async () => {
        markCalls += 1;
        if (markCalls === 1) throw new Error("temporary failure");
        serverUnread = 0;
      };

      client = new QueryClient({
        defaultOptions: { queries: { retry: false, refetchIntervalInBackground: false } },
      });
      client.setQueryData(chatsQuery.queryKey, [summary(3, 2)]);

      mounted = await mountFakeDom(
        createElement(QueryClientProvider, { client }, createElement(Harness, { id: CHAT_ID })),
      );
      await mounted.act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(markCalls).toBe(1);

      await mounted.act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(markCalls).toBe(2);
      expect(client.getQueryData(chatsQuery.queryKey)?.[0]?.unread).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
