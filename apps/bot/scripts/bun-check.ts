// What production loads, on Bun, while production runs on Bun and the tests run on Node: boots the
// bot's entry as the image does, on a temporary data home with no keys, and checks its routes, the
// usage ledger on node:sqlite, the provider socket client against a local server, and a clean exit
// on SIGTERM. CI runs it.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectWs, WsHandshakeError } from "@eidolon/providers";
import { UsageLedger } from "@eidolon/usage";
import { Output } from "./output.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const LISTENING = /Bot server listening on (http:\/\/127\.0\.0\.1:\d+\/)/;
const BOOT_TIMEOUT_MS = 60_000;

let failures = 0;

function check(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!pass) failures++;
}

/** The bot's routes on srvx, and its ledger, with nothing configured. */
async function checkBot(home: string): Promise<void> {
  const bot = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "apps/bot/src/main.ts",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        EIDOLON_HOME: home,
        EIDOLON_NO_DOTENV: "1",
        NODE_ENV: "production",
        ORT_DISABLE_TELEMETRY: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new Output(bot.stdout);
  const stderr = new Output(bot.stderr);
  try {
    let origin: string;
    try {
      origin = await stdout.waitFor(LISTENING, bot.exited, BOOT_TIMEOUT_MS);
      check("boot", true, origin);
    } catch {
      check("boot", false, `no listening line\n${stdout.tail()}\n${stderr.tail()}`);
      return;
    }
    check(
      "usage ledger",
      existsSync(join(home, "usage.db")) && !stderr.text.includes("Usage ledger off"),
      `${join(home, "usage.db")} opened`,
    );
    const ice = await fetch(`${origin}api/ice-servers`);
    const body = await ice.text();
    check(
      "GET /api/ice-servers",
      ice.status === 200 && body === '{"iceServers":[]}',
      `${ice.status} ${body}`,
    );
    const head = await fetch(`${origin}api/ice-servers`, { method: "HEAD" });
    check(
      "HEAD /api/ice-servers",
      head.status === 405 && head.headers.get("allow") === "GET",
      `${head.status}, allow ${head.headers.get("allow")}`,
    );
    const missing = await fetch(`${origin}nope`);
    const detail = await missing.text();
    check(
      "GET /nope",
      missing.status === 404 && detail === '{"detail":"Not Found"}',
      `${missing.status} ${detail}`,
    );
    const preflight = await fetch(`${origin}mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://example.com", "access-control-request-method": "POST" },
    });
    check(
      "OPTIONS /mcp",
      preflight.status === 200 &&
        preflight.headers.get("access-control-allow-origin") === "https://example.com",
      `${preflight.status}, allow-origin ${preflight.headers.get("access-control-allow-origin")}`,
    );
    bot.kill("SIGTERM");
    const code = await Promise.race([bot.exited, Bun.sleep(10_000).then(() => null)]);
    check("SIGTERM", code === 0, `exit ${code}`);
    // What it logged on its way out can still be in the pipe.
    if (code !== null) await stderr.done;
    const errors = stderr.text.split("\n").filter((line) => /\| (ERROR|CRITICAL) /.test(line));
    check("errors", errors.length === 0, errors.join("\n") || "none logged");
  } finally {
    bot.kill("SIGKILL");
  }
}

/** A usage record written and summed through named and positional parameters. */
function checkLedger(home: string): void {
  const ledger = new UsageLedger(join(home, "check", "usage.db"));
  try {
    ledger.record(
      {
        at: Date.now(),
        source: "call",
        session: "bun-check",
        role: "mind",
        category: "llm",
        provider: "openrouter",
        model: "check",
        units: { inputTokens: 3, outputTokens: 2 },
        costUsd: 0.25,
        costSource: "reported",
      },
      "milky-green",
    );
    const { rows, personas } = ledger.summarize({ persona: "milky-green" });
    check(
      "usage summary",
      rows.length === 1 && rows[0]?.costUsd === 0.25 && personas.join() === "milky-green",
      JSON.stringify({ rows: rows.length, costUsd: rows[0]?.costUsd, personas }),
    );
  } finally {
    ledger.close();
  }
}

/** The provider socket client, through `ws` (Bun's own in its place), against Bun's server. */
async function checkSocket(): Promise<void> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (new URL(request.url).pathname === "/refuse") return new Response(null, { status: 401 });
      return bun.upgrade(request, { headers: { "x-check": "1" } })
        ? undefined
        : new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, data) {
        if (data === "bye") socket.close(1000, "done");
        else socket.send(data);
      },
    },
  });
  try {
    const signal = AbortSignal.timeout(10_000);
    const socket = await connectWs(`ws://127.0.0.1:${server.port}/echo`, { "x-key": "k" }, signal);
    socket.send("ping");
    socket.send(new Uint8Array([1, 2, 3]));
    socket.send("bye");
    const got: string[] = [];
    for await (const message of socket.messages) {
      got.push(typeof message === "string" ? message : `bytes ${[...message].join(",")}`);
    }
    check(
      "socket",
      got.join(" | ") === "ping | bytes 1,2,3" && socket.closeCode === 1000,
      `${got.join(" | ")}; closed ${socket.closeCode} ${socket.closeReason}`,
    );
    const refused = await connectWs(`ws://127.0.0.1:${server.port}/refuse`, {}, signal).then(
      () => null,
      (error: unknown) => error,
    );
    check(
      "socket refused",
      refused instanceof WsHandshakeError && refused.status === 401,
      String(refused),
    );
  } finally {
    await server.stop(true);
  }
}

const home = mkdtempSync(join(tmpdir(), "eidolon-bun-check-"));
try {
  console.log(`Bun ${Bun.version}`);
  await checkBot(home);
  checkLedger(home);
  await checkSocket();
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log(failures === 0 ? "Every check passed." : `${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
