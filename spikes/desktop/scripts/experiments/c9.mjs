// C9: sizes, and cold start of the packaged app: launch → backend listening → Home painted, over a
// first run on a fresh data home and then three launches on that home. No CDP, no fake devices; the
// window is kept on top until Home is probed so occlusion can't stop its frames.
// usage: node c9.mjs <run name> <free port>
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { launchApp, makeRun, PACKAGED_APP, processes, SPIKE, shellEvents, sleep, waitForEvent, writeEvidence } from "../lib.mjs";

const name = process.argv[2] ?? "pkg-c9";
const port = Number(process.argv[3] ?? 17861);
const out = { run: name, preferredPort: port, launches: [] };

const du = (path) => Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0]) / 1024;
const app = PACKAGED_APP;
out.sizesMB = {
  app: du(app),
  frameworks: du(join(app, "Contents/Frameworks")),
  resourcesEidolon: du(join(app, "Contents/Resources/eidolon")),
  lancedbNode: du(join(app, "Contents/Resources/eidolon/node_modules/@lancedb")),
  onnxruntime: du(join(app, "Contents/Resources/eidolon/node_modules/onnxruntime-node")),
  sharp: du(join(app, "Contents/Resources/eidolon/node_modules/@img")) + du(join(app, "Contents/Resources/eidolon/node_modules/sharp")),
  appAsar: du(join(app, "Contents/Resources/app.asar")),
};
const files = execFileSync("ls", ["-l", join(SPIKE, ".out")], { encoding: "utf8" });
out.artifacts = files.split("\n").filter((l) => /\.(dmg|zip)$/.test(l)).map((l) => {
  const parts = l.trim().split(/\s+/);
  return { file: parts.at(-1), MB: Math.round((Number(parts[4]) / 1024 / 1024) * 10) / 10 };
});

for (let i = 0; i < 4; i++) {
  const run = makeRun(name, { preferredPort: port, onTop: true });
  const before = shellEvents(run).length;
  const launched = launchApp(run, { packaged: true });
  const probe = await waitForEvent(run, (e) => e.event === "home-probe" || e.event === "backend-failed", 90_000, launched.spawnedAt);
  const events = shellEvents(run).slice(before);
  const at = (event) => events.find((e) => e.event === event)?.at ?? null;
  const rel = (value) => (value === null || value === undefined ? null : value - launched.spawnedAt);
  const listening = events.find((e) => e.event === "backend-listening");
  const loginShell = events.find((e) => e.event === "login-shell");
  await sleep(1500);
  const rss = Object.fromEntries(
    processes(app).concat(processes("Resources/eidolon/dist/server.js")).map((p) => {
      const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(p.pid)], { encoding: "utf8" }).trim() || 0);
      const label = p.command.includes("dist/server.js") ? "backend" : p.command.includes("(Renderer)") ? "renderer" : p.command.includes("(GPU)") ? "gpu" : p.command.includes("utility") ? `utility ${p.pid}` : p.command.includes("Helper") ? `helper ${p.pid}` : "main";
      return [label, Math.round(kb / 1024)];
    }),
  );
  const quitAt = Date.now();
  launched.child.kill("SIGTERM");
  const exited = await Promise.race([launched.exited, sleep(30_000).then(() => null)]);
  const stopped = shellEvents(run).slice(before).find((e) => e.event === "backend-stopped");
  out.launches.push({
    launch: i === 0 ? "first run (fresh data home)" : `launch ${i + 1}`,
    mainStart: rel(at("main-start")),
    appReady: rel(at("app-ready")),
    windowShown: rel(at("window-show")),
    loginShellMs: loginShell?.ms,
    backendSpawned: rel(at("backend-spawn")),
    backendListening: rel(listening?.at),
    backendBootMs: listening?.ms,
    appLoadStarted: rel(at("loading-app")),
    appDidFinishLoad: rel(events.find((e) => e.event === "did-finish-load" && e.url?.startsWith("eidolon-app://app/"))?.at),
    homeFcp: rel(probe?.fcpAt),
    sidebarInDom: rel(probe?.sidebarAt),
    sidebarPainted: rel(probe?.sidebarPaintedAt),
    windowButtons: probe?.windowButtons,
    sidebarHeaderRect: probe?.sidebarHeaderRect,
    rssMB: rss,
    quit: { backendExit: stopped?.code, backendStopMs: stopped?.ms, appExit: exited?.code, appExitMs: exited ? exited.at - quitAt : null },
  });
  console.log(JSON.stringify(out.launches.at(-1)));
  await sleep(1000);
}
const measured = out.launches.slice(1);
const median = (key) => {
  const values = measured.map((l) => l[key]).filter((v) => typeof v === "number").sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
};
out.median = { backendListening: median("backendListening"), sidebarPainted: median("sidebarPainted"), homeFcp: median("homeFcp"), loginShellMs: median("loginShellMs"), backendBootMs: median("backendBootMs") };
writeEvidence(`${name}-results.json`, out);
console.log(JSON.stringify({ sizesMB: out.sizesMB, artifacts: out.artifacts, median: out.median }, null, 1));
