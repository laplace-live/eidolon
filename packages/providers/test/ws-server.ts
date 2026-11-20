// Loopback servers for the socket clients' fakes: ws's WebSocketServer on node:http, which refuses
// a handshake with a Response or accepts it, and a bare TCP listener for peers that break the
// protocol. Stopping either drops every connection at once.
import { createServer, type IncomingMessage, type ServerResponse, STATUS_CODES } from "node:http";
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

export interface Handshake {
  readonly url: URL;
  readonly headers: Headers;
}

export interface WsHandlers {
  /** A Response refuses the handshake with its status and body; none accepts it. */
  readonly handshake?: (
    handshake: Handshake,
  ) => Response | undefined | Promise<Response | undefined>;
  readonly open: (socket: WebSocket, handshake: Handshake) => void;
  /** Answers a request that isn't a handshake; without it, 400. */
  readonly fetch?: (request: Request) => Response | Promise<Response>;
}

export interface Listening {
  readonly port: number;
  stop(): Promise<void>;
}

/** What a socket received: text as a string, binary as bytes of its own. */
export function messageOf(data: RawData, isBinary: boolean): string | Uint8Array {
  return isBinary ? new Uint8Array(data as Buffer) : (data as Buffer).toString();
}

function handshakeOf(request: IncomingMessage): Handshake {
  const headers = new Headers();
  const raw = request.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) headers.append(raw[i] as string, raw[i + 1] as string);
  return { url: new URL(request.url ?? "/", `http://${request.headers.host}`), headers };
}

async function listen(server: Server): Promise<Listening> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    // A client that hangs up can reset a socket nothing else listens on, such as an upgrade still
    // waiting on its handshake.
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  // Bound to every address, the port can be shared with another process's 127.0.0.1 listener,
  // which then answers a client dialling 127.0.0.1 in its place.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** `response` as raw HTTP, for a socket the HTTP server has handed over. */
async function raw(response: Response): Promise<string> {
  const body = await response.text();
  const head = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}`];
  for (const [name, value] of response.headers) head.push(`${name}: ${value}`);
  head.push(`Content-Length: ${Buffer.byteLength(body)}`, "Connection: close");
  return `${head.join("\r\n")}\r\n\r\n${body}`;
}

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  fetch: WsHandlers["fetch"],
): Promise<void> {
  if (fetch === undefined) {
    response.writeHead(400).end("no upgrade");
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const { url, headers } = handshakeOf(request);
  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? null : new Uint8Array(Buffer.concat(chunks));
  const reply = await fetch(new Request(url, { method, headers, body }));
  response.writeHead(reply.status, Object.fromEntries(reply.headers));
  // Each piece goes out as it comes, for the clients that read a body as it streams.
  const reader = reply.body?.getReader();
  for (;;) {
    const read = await reader?.read();
    if (read === undefined || read.done) break;
    response.write(read.value);
  }
  response.end();
}

/** A WebSocket server on 127.0.0.1 at a free port, answering as `handlers` say. */
export async function serveWs(handlers: WsHandlers): Promise<Listening> {
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer(
    (request, response) => void answer(request, response, handlers.fetch),
  );
  server.on("upgrade", async (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const handshake = handshakeOf(request);
    const refusal = await handlers.handshake?.(handshake);
    if (refusal !== undefined) socket.end(await raw(refusal));
    else sockets.handleUpgrade(request, socket, head, (ws) => handlers.open(ws, handshake));
  });
  return listen(server);
}

/** A TCP listener on 127.0.0.1 at a free port, handing each connection to `onSocket`. */
export function serveTcp(onSocket: (socket: Socket) => void): Promise<Listening> {
  return listen(createTcpServer(onSocket));
}
