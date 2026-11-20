// A server that starts a helper in its process group, which ignores SIGTERM and holds none of the
// server's pipes. It prints `helper <pid>` once the helper ignores SIGTERM, then exits when its
// stdin closes, or at once with --exit.
import { spawn } from "node:child_process";

const helper = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
  { stdio: ["ignore", "pipe", "ignore"] },
);
helper.stdout.once("data", () => {
  console.error(`helper ${helper.pid}`);
  if (process.argv.includes("--exit")) process.exit(0);
});
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
