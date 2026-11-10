import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Server, TCPSocketListener } from "bun";
import {
  backoffMs,
  connectWs,
  QuickFailureTracker,
  type WsConnection,
  type WsData,
  WsHandshakeError,
} from "../src/index.ts";

interface Peer {
  readonly path: string;
  readonly auth: string | null;
}

let server: Server<Peer>;
const serverSaw: { code: number; reason: string }[] = [];

beforeAll(() => {
  server = Bun.serve<Peer>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      const { pathname } = new URL(request.url);
      if (pathname === "/deny") return new Response("bad key", { status: 401 });
      if (pathname === "/slow") await Bun.sleep(500);
      const data = { path: pathname, auth: request.headers.get("authorization") };
      if (srv.upgrade(request, { data })) return undefined;
      return new Response("no upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (ws.data.path === "/close") {
          ws.send("bye");
          ws.close(1011, "boom");
          return;
        }
        if (ws.data.path === "/echo") ws.send(JSON.stringify({ auth: ws.data.auth }));
      },
      message(ws, message) {
        ws.send(message);
      },
      close(_ws, code, reason) {
        serverSaw.push({ code, reason });
      },
    },
  });
});

afterAll(() => server.stop(true));

const url = (path: string) => `ws://127.0.0.1:${server.port}${path}`;
const live = () => new AbortController().signal;

async function next(connection: WsConnection): Promise<WsData | undefined> {
  for await (const message of connection.messages) return message;
  return undefined;
}

async function rest(connection: WsConnection): Promise<WsData[]> {
  const messages: WsData[] = [];
  for await (const message of connection.messages) messages.push(message);
  return messages;
}

test("sends the handshake headers, and carries text as strings and binary as bytes", async () => {
  const connection = await connectWs(url("/echo"), { Authorization: "Bearer key-1" }, live());
  expect(connection.open).toBe(true);
  expect(JSON.parse((await next(connection)) as string)).toEqual({ auth: "Bearer key-1" });
  connection.send("hello");
  connection.send(new Uint8Array([1, 2, 3]));
  expect(await next(connection)).toBe("hello");
  const bytes = await next(connection);
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect([...(bytes as Uint8Array)]).toEqual([1, 2, 3]);
  await connection.close();
  expect(connection.open).toBe(false);
  expect(connection.closeCode).toBe(1000);
});

test("a server's close ends the messages after the last one, with its code and reason", async () => {
  const connection = await connectWs(url("/close"), {}, live());
  expect(await rest(connection)).toEqual(["bye"]);
  expect(connection.open).toBe(false);
  expect(connection.closeCode).toBe(1011);
  expect(connection.closeReason).toBe("boom");
  connection.send("dropped");
  await connection.close();
});

test("a refused handshake rejects with its status, naming neither the query nor the key", async () => {
  const error = await connectWs(
    url("/deny?token=query-secret"),
    { Authorization: "Bearer header-secret" },
    live(),
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(WsHandshakeError);
  expect((error as WsHandshakeError).status).toBe(401);
  const { message } = error as Error;
  expect(message).toContain(`127.0.0.1:${server.port}/deny`);
  expect(message).not.toContain("query-secret");
  expect(message).not.toContain("header-secret");
});

test("an abort fails a handshake with its reason, and closes an open socket", async () => {
  const reason = new Error("call over");
  await expect(connectWs(url("/echo"), {}, AbortSignal.abort(reason))).rejects.toBe(reason);

  const midway = new AbortController();
  const pending = connectWs(url("/slow"), {}, midway.signal);
  setTimeout(() => midway.abort(reason), 50);
  await expect(pending).rejects.toBe(reason);

  const call = new AbortController();
  const connection = await connectWs(url("/echo"), {}, call.signal);
  await next(connection);
  serverSaw.length = 0;
  call.abort(reason);
  expect(await rest(connection)).toEqual([]);
  expect(connection.closeCode).toBe(1000);
  await Bun.sleep(20);
  expect(serverSaw).toEqual([{ code: 1000, reason: "" }]);
});

test("close drops a peer that never acknowledges it after 2 s", async () => {
  const accept = (key: string) =>
    createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  const listener: TCPSocketListener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(data.toString())?.[1];
        if (key === undefined) return;
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept(key.trim())}\r\n\r\n`,
        );
      },
    },
  });
  try {
    const connection = await connectWs(`ws://127.0.0.1:${listener.port}/`, {}, live());
    jest.useFakeTimers();
    const closing = connection.close();
    jest.advanceTimersByTime(1_999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(connection.closeCode).toBeNull();
    jest.advanceTimersByTime(1);
    await closing;
    expect(connection.closeCode).toBe(1006);
    expect(await rest(connection)).toEqual([]);
  } finally {
    jest.useRealTimers();
    listener.stop(true);
  }
});

test("reconnects back off as pipedog's did: 4 s, 4 s, 4 s, 8 s, then 10 s", () => {
  expect([1, 2, 3, 4, 5, 6, 40].map(backoffMs)).toEqual([
    4000, 4000, 4000, 8000, 10_000, 10_000, 10_000,
  ]);
});

test("three connections in a row that die within 5 s give up; a stable one resets the count", () => {
  const tracker = new QuickFailureTracker();
  expect(tracker.record(0)).toBe(false);
  expect(tracker.record(4999)).toBe(false);
  expect(tracker.record(5000)).toBe(false);
  expect(tracker.record(10)).toBe(false);
  expect(tracker.record(10)).toBe(false);
  expect(tracker.record(10)).toBe(true);
});
