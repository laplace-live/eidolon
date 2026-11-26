import type { ChatEvent, ChatStreamLine } from "@eidolon/chat";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatContents } from "@/lib/chats";
import { type MountedRoot, mountFakeDom } from "@/test/fake-dom";
import { linguiMacro } from "@/test/lingui-macro";

let followImpl: (id: string, signal: AbortSignal) => AsyncGenerator<ChatStreamLine>;
let readImpl: (id: string, signal?: AbortSignal) => Promise<ChatContents>;

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@/lib/feedback", () => ({ toastError: () => {} }));
vi.doMock("@/features/companion/chat-facts", () => ({
  saidFacts: () => [],
  tellCompanion: () => {},
}));
vi.doMock("@/lib/chats", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chats")>("@/lib/chats");
  return {
    ...actual,
    followLive: (id: string, signal: AbortSignal) => followImpl(id, signal),
    readChat: (id: string, signal?: AbortSignal) => readImpl(id, signal),
  };
});

const { chatQuery } = await import("./queries");
const { useChat } = await import("./use-chat");

const CHAT_ID = "01900000-0000-7000-8000-000000000099";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const msg = (seq: number, kind: "user" | "persona", text: string): ChatEvent => ({
  seq,
  at: 1000 + seq,
  type: "message",
  id: `e${seq}`,
  speaker: kind === "user" ? { kind: "user" } : { kind: "persona", id: "milky-green" },
  text,
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

function Harness({
  serverActive,
  serverLastSeq,
}: {
  readonly serverActive: boolean;
  readonly serverLastSeq: number;
}) {
  useQuery(chatQuery(CHAT_ID));
  useChat(CHAT_ID, false, null, false, serverActive, serverLastSeq);
  return null;
}

describe("useChat background recovery", () => {
  let mounted: MountedRoot | null = null;
  let client: QueryClient | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (mounted !== null) {
      await mounted.render(null);
    }
    if (client !== null) {
      await client.cancelQueries();
      client.unmount();
      client.clear();
      client = null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (mounted !== null) {
      const current = mounted;
      mounted = null;
      await current.unmount();
    }
  });

  test("rejoins live stream while serverActive stays true after initial 204", async () => {
    vi.useFakeTimers();
    let liveCalls = 0;
    let rereadCalls = 0;
    const postReread = deferred<ChatContents>();
    const initial = contents([msg(1, "user", "hi")]);
    const reply = msg(2, "persona", "转完之后回复啦");
    followImpl = async function* () {
      liveCalls += 1;
      if (liveCalls === 1) return;
      yield { type: "events", events: [reply] };
    };
    // Initial reads omit reply; post-stream reread stays pending until stream merge is verified.
    readImpl = async () => {
      rereadCalls += 1;
      return liveCalls < 2 ? initial : postReread.promise;
    };

    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(chatQuery(CHAT_ID).queryKey, initial);

    mounted = await mountFakeDom(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness, { serverActive: true, serverLastSeq: 1 }),
      ),
    );
    await mounted.act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(liveCalls).toBe(1);
    expect(rereadCalls).toBeGreaterThanOrEqual(1);

    await mounted.act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(liveCalls).toBe(2);
    expect(client.getQueryData(chatQuery(CHAT_ID).queryKey)?.events).toEqual([
      msg(1, "user", "hi"),
      reply,
    ]);
    await mounted.act(async () => {
      postReread.resolve(contents([msg(1, "user", "hi"), reply]));
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  test("rereads an empty loaded chat when serverLastSeq advances while idle", async () => {
    const empty = contents([]);
    const updated = contents([msg(1, "user", "hi"), msg(2, "persona", "群聊第一条")]);
    let current = empty;
    followImpl = async function* () {};
    readImpl = async () => current;

    client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchIntervalInBackground: false } },
    });
    client.setQueryData(chatQuery(CHAT_ID).queryKey, empty);

    mounted = await mountFakeDom(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness, { serverActive: false, serverLastSeq: 0 }),
      ),
    );
    await mounted.act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    current = updated;
    await mounted.act(async () => {
      await mounted!.render(
        createElement(
          QueryClientProvider,
          { client: client! },
          createElement(Harness, { serverActive: false, serverLastSeq: 2 }),
        ),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => {
      expect(client!.getQueryData(chatQuery(CHAT_ID).queryKey)?.events.at(-1)?.seq).toBe(2);
    });
  });

  test("retries idle catch-up reread after a transient read failure", async () => {
    vi.useFakeTimers();
    const initial = contents([msg(1, "user", "hi")]);
    const updated = contents([msg(1, "user", "hi"), msg(2, "persona", "恢复了")]);
    let phase: "idle" | "fail" | "ok" = "idle";
    let failedOnce = false;
    followImpl = async function* () {};
    readImpl = async () => {
      if (phase === "idle") return initial;
      if (phase === "fail" && !failedOnce) {
        failedOnce = true;
        throw new Error("temporary read error");
      }
      return updated;
    };

    client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchIntervalInBackground: false } },
    });
    client.setQueryData(chatQuery(CHAT_ID).queryKey, initial);

    mounted = await mountFakeDom(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness, { serverActive: false, serverLastSeq: 1 }),
      ),
    );
    await mounted.act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    phase = "fail";
    await mounted.act(async () => {
      await mounted!.render(
        createElement(
          QueryClientProvider,
          { client: client! },
          createElement(Harness, { serverActive: false, serverLastSeq: 2 }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(failedOnce).toBe(true);
    expect(client.getQueryData(chatQuery(CHAT_ID).queryKey)?.events.at(-1)?.seq).toBe(1);

    phase = "ok";
    await mounted.act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.getQueryData(chatQuery(CHAT_ID).queryKey)?.events.at(-1)?.seq).toBe(2);
  });

  test("rereads log when serverLastSeq advances while idle", async () => {
    let reads = 0;
    const initial = contents([msg(1, "user", "hi")]);
    const updated = contents([msg(1, "user", "hi"), msg(2, "persona", "已存完")]);
    let current = initial;
    followImpl = async function* () {};
    readImpl = async () => {
      reads += 1;
      return current;
    };

    client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchIntervalInBackground: false } },
    });
    client.setQueryData(chatQuery(CHAT_ID).queryKey, initial);

    mounted = await mountFakeDom(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness, { serverActive: false, serverLastSeq: 1 }),
      ),
    );
    await mounted.act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const readsAtIdle = reads;

    current = updated;
    await mounted.act(async () => {
      await mounted!.render(
        createElement(
          QueryClientProvider,
          { client: client! },
          createElement(Harness, { serverActive: false, serverLastSeq: 2 }),
        ),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => {
      expect(reads).toBeGreaterThan(readsAtIdle);
      expect(client!.getQueryData(chatQuery(CHAT_ID).queryKey)?.events.at(-1)?.seq).toBe(2);
    });
  });
});
