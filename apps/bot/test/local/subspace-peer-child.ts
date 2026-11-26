// Child process peer server for testing Subspace proxying across two isolated EIDOLON_HOME dirs.
import * as access from "@eidolon/access";
import { installSettings } from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import { type BootIo, bootLocal, type LocalModules } from "../../src/local/boot.ts";
import { loadLocalToken } from "../../src/local/token.ts";

const [, , distDir] = process.argv;
if (!distDir) {
  process.stderr.write("Usage: subspace-peer-child.ts <distDir>\n");
  process.exit(2);
}

const modules: LocalModules = {
  access: {
    ...access,
    admitOffer: async (input) =>
      access.admitOffer(input, { quota: new access.SlidingWindowQuota(5, 3600) }),
    anonOfferQuota: () => ({ maxPerWindow: 5, windowSeconds: 3600 }),
  },
  imagegen: { selfieResponse: () => new Response(null, { status: 404 }) },
  memory: { memoryAdmin: (): MemoryAdmin | null => null },
  retrieval: {
    warmTokenizer: () => {},
    resolveDbPath: () => "/fake/index",
    warmStreamCatalog: async () => {},
  },
  runtime: {
    configureLogging: () => {},
    warmAudioModels: async () => {},
    createSignallingServer: () => ({
      offer: async () => ({
        status: 200,
        body: {
          sdp: [
            "v=0",
            "o=- 1 1 IN IP4 127.0.0.1",
            "s=-",
            "t=0 0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111",
            "a=candidate:1 1 udp 2122260223 127.0.0.1 45678 typ host generation 0",
            "",
          ].join("\r\n"),
          type: "answer",
          pc_id: "peer",
        },
      }),
      patch: async () => ({ status: 200, body: { status: "success" } }),
      close: async () => {},
      activeSessions: 0,
    }),
  },
  turn: {
    iceServiceFromEnv: () => ({
      browserPayload: async () => ({ iceServers: [] }),
      serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }),
    }),
  },
  mcp: { createMcpHandler: async () => ({ handle: async () => new Response("mcp") }) },
};

let shutdownHandler: (() => void) | null = null;
const io: BootIo = {
  stdout: () => {},
  stderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
  openBrowser: () => {},
  onShutdown: (handler) => {
    shutdownHandler = handler;
  },
  notify: () => {},
  nowSeconds: () => Date.now() / 1000,
};

installSettings();
const server = await bootLocal(["--host", "127.0.0.1", "--port", "0", "--no-open"], modules, {
  dist: distDir,
  io,
});
if (server === null) {
  process.stderr.write("subspace-peer-child failed to bootLocal\n");
  process.exit(1);
}

const port = server.bot.server.port as number;
const baseUrl = `http://127.0.0.1:${port}`;
const token = loadLocalToken().secret;
const authHeaders = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

const createChat = await fetch(`${baseUrl}/api/local/chats`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ participants: ["milky-green"] }),
});
if (!createChat.ok) {
  process.stderr.write(`createChat failed (${createChat.status}): ${await createChat.text()}\n`);
  process.exit(1);
}
const { id: remoteChatId } = (await createChat.json()) as { id: string };
const renameChat = await fetch(`${baseUrl}/api/local/chats/${encodeURIComponent(remoteChatId)}`, {
  method: "PATCH",
  headers: authHeaders,
  body: JSON.stringify({ title: "Remote Subspace Chat" }),
});
if (!renameChat.ok) {
  process.stderr.write(`renameChat failed (${renameChat.status}): ${await renameChat.text()}\n`);
  process.exit(1);
}

const offerRes = await fetch(`${baseUrl}/api/local/subspace/share/offer`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ mode: "direct", address: "127.0.0.1", port: 0 }),
});
if (!offerRes.ok) {
  process.stderr.write(`offerRes failed (${offerRes.status}): ${await offerRes.text()}\n`);
  process.exit(1);
}
const offer = (await offerRes.json()) as { pairingUrl: string };

process.stdout.write(
  `SUBSPACE_PEER_READY:${JSON.stringify({ baseUrl, pairingUrl: offer.pairingUrl, remoteChatId })}\n`,
);

process.stdin.resume();
process.stdin.on("end", () => shutdownHandler?.());
process.on("SIGTERM", () => shutdownHandler?.());
process.on("SIGINT", () => shutdownHandler?.());
