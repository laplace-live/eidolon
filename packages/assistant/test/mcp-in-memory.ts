// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/src/transports/in-memory.ts@ac78a60
//
// Two transports wired to each other, for the client's tests.
import { type JsonRpcMessage, McpConnectionClosedError } from "../src/mcp/protocol/jsonrpc.ts";
import { type McpTransport, TransportEvents } from "../src/mcp/transports/transport.ts";

export class InMemoryTransport extends TransportEvents implements McpTransport {
  #peer: InMemoryTransport | undefined;
  #started = false;
  #closed = false;

  connectPeer(peer: InMemoryTransport): void {
    if (this.#peer) throw new Error("In-memory MCP transport already has a peer");
    this.#peer = peer;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new McpConnectionClosedError();
    this.#started = true;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.#started || this.#closed) throw new McpConnectionClosedError();
    const peer = this.#peer;
    if (peer === undefined || !peer.#started || peer.#closed) {
      throw new McpConnectionClosedError("In-memory MCP peer is not connected");
    }
    const copy = structuredClone(message);
    queueMicrotask(() => peer.#deliver(copy));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.emitClose();
    await this.#peer?.close();
  }

  /** Exposed so tests can simulate transport-level failures. */
  override emitError(error: unknown): void {
    super.emitError(error);
  }

  #deliver(message: JsonRpcMessage): void {
    if (this.#closed) return;
    this.emitMessage(message);
  }
}

export function createInMemoryTransportPair(): {
  client: InMemoryTransport;
  server: InMemoryTransport;
} {
  const client = new InMemoryTransport();
  const server = new InMemoryTransport();
  client.connectPeer(server);
  server.connectPeer(client);
  return { client, server };
}
