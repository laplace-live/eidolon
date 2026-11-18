// A server that starts a helper in a session of its own, as a daemon or `setsid` does, which keeps
// the server's stdout and stderr: no kill of the server's process group reaches it. It answers
// initialize unless --hang, and exits once its stdin closes; --pidfile PATH writes both pids there.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
helper.unref();
console.error(`helper ${helper.pid}`);
const pidfile = argv.indexOf("--pidfile");
if (pidfile !== -1) writeFileSync(argv[pidfile + 1], JSON.stringify([process.pid, helper.pid]));

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (argv.includes("--hang") || message.method !== "initialize") return;
  const result = {
    protocolVersion: "2025-06-18",
    capabilities: {},
    serverInfo: { name: "daemon-fixture", version: "1.0.0" },
  };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
lines.on("close", () => process.exit(0));
