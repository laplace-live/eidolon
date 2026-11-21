// C11: the packaged binary's fuses as built, and whether SIGUSR1 opens an inspector in the backend
// (spawned with --disable-sigusr1) and, as controls, in the same binary run as Node without the flag
// (as jsRuntime() starts job children), with --inspect, and with NODE_OPTIONS.
// usage: node c11.mjs <run name>
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { launchApp, makeRun, PACKAGED, PACKAGED_APP, recordPid, SPIKE, shellEvents, sleep, waitForEvent, writeEvidence } from "../lib.mjs";

const name = process.argv[2] ?? "pkg-c11";
const out = { run: name };

function listeners() {
  try {
    return execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })
      .split("\n")
      .filter((l) => /:(9229|9230|9231)\s/.test(l))
      .map((l) => l.replace(/\s+/g, " "));
  } catch {
    return [];
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

out.fuses = execFileSync("npx", ["--no-install", "@electron/fuses", "read", "--app", PACKAGED_APP], { cwd: SPIKE, encoding: "utf8" })
  .split("\n")
  .filter((l) => l.trim().startsWith("") && / is (Enabled|Disabled)/.test(l))
  .map((l) => l.trim());
out.before = listeners();

// ---- the backend as the shell spawns it -----------------------------------------------------------
const run = makeRun(name, { preferredPort: 0 });
const app = launchApp(run, { packaged: true });
try {
  const listening = await waitForEvent(run, (e) => e.event === "backend-listening", 60_000);
  const pid = listening.pid;
  recordPid(pid, `backend of ${name}`);
  const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim().replaceAll(SPIKE, "<spike>");
  const at = Date.now();
  process.kill(pid, "SIGUSR1");
  await sleep(1500);
  out.backend = {
    command,
    afterSigusr1: listeners(),
    alive: alive(pid),
    exitEvents: shellEvents(run).filter((e) => e.at >= at && (e.event === "backend-exit" || e.event === "backend-died")),
    stderrAfter: shellEvents(run).length,
  };
  await sleep(200);
} finally {
  app.child.kill("SIGTERM");
  await Promise.race([app.exited, sleep(20_000)]);
  out.backend.quit = shellEvents(run).filter((e) => e.event === "backend-stopped").map((e) => ({ code: e.code, signal: e.signal, ms: e.ms }));
}

// ---- controls: the same binary as Node, as a job child or a hostile local caller would run it ------
async function control(label, args, extraEnv = {}, signal = "SIGUSR1") {
  const env = { HOME: process.env.HOME, PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1", ...extraEnv };
  const child = spawn(PACKAGED, [...args, "-e", "setTimeout(() => {}, 20000)"], { env, stdio: ["ignore", "pipe", "pipe"] });
  recordPid(child.pid, `c11 control ${label}`);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  await sleep(800);
  if (signal) process.kill(child.pid, signal);
  await sleep(1200);
  const result = { label, args: args.join(" ") || "(none)", env: Object.keys(extraEnv), listeners: listeners(), alive: alive(child.pid), stderr: stderr.trim().split("\n").filter(Boolean).slice(0, 2) };
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("exit", resolve));
  return result;
}
out.controls = [
  await control("no flag + SIGUSR1 (a jsRuntime() child)", []),
  await control("--disable-sigusr1 + SIGUSR1", ["--disable-sigusr1"]),
  await control("--inspect=127.0.0.1:9230", ["--inspect=127.0.0.1:9230"], {}, null),
  await control("NODE_OPTIONS=--inspect=127.0.0.1:9231", [], { NODE_OPTIONS: "--inspect=127.0.0.1:9231" }, null),
];
out.after = listeners();
writeEvidence(`${name}-results.json`, out);
console.log(JSON.stringify(out, null, 1));
