// Launches the two tampered copies (<runs>/tamper/{Payload,Asar}.app) with a spike run each and reports
// whether the shell and the backend start. Asar integrity covers app.asar only; the backend's JS in
// Resources/eidolon is covered by the signature's resource seal, which nothing checks at launch.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { finderEnv, makeRun, recordPid, RUNS, shellEvents, sleep, waitForEvent, writeEvidence } from "../lib.mjs";
const out = {};
for (const which of ["Payload", "Asar"]) {
  const run = makeRun(`tamper-${which.toLowerCase()}`, { preferredPort: 0 });
  const binary = join(RUNS, `tamper/${which}.app/Contents/MacOS/Eidolon`);
  const child = spawn(binary, [], { env: finderEnv(run.file), stdio: ["ignore", "pipe", "pipe"] });
  recordPid(child.pid, `tampered ${which}.app`);
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const listening = await waitForEvent(run, (e) => e.event === "backend-listening", 20_000);
  const early = await Promise.race([exited, sleep(100).then(() => null)]);
  if (early === null) {
    child.kill("SIGTERM");
  }
  const exit = await Promise.race([exited, sleep(20_000).then(() => null)]);
  if (exit === null) child.kill("SIGKILL");
  out[which] = {
    shellStarted: shellEvents(run).some((e) => e.event === "main-start"),
    backendListening: !!listening,
    backendCommand: listening ? "<tampered app>/Contents/MacOS/Eidolon --disable-sigusr1 <payload>/dist/server.js …" : null,
    exit,
    output: output.split("\n").filter(Boolean).slice(0, 4),
  };
}
writeEvidence("tamper-results.json", out);
console.log(JSON.stringify(out, null, 1));
