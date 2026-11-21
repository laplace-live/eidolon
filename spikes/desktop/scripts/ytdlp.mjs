// W8, optional: yt-dlp solving YouTube's JavaScript challenges with the app binary as its Node
// runtime, as the managed yt-dlp runs (packages/ingest/src/download/argv.ts jsRuntimeArgs), with
// ELECTRON_RUN_AS_NODE=1 inherited from the backend. --no-js-runtimes comes first: yt-dlp prefers a
// Deno it finds. --simulate downloads nothing; a bot check or a network failure skips the check.
// Writes <evidence>/<name>-ytdlp.json and always exits 0.
// usage: node scripts/ytdlp.mjs --app <Eidolon.exe> --name <label>
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { IS_WINDOWS, RUNS, writeEvidence } from "./lib.mjs";

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}
const APP = resolve(option("app", join(process.env.LOCALAPPDATA ?? "", "Programs", "eidolon", "Eidolon.exe")));
const NAME = option("name", "installed");
// "Me at the zoo": 19 s, public since 2005.
const VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const ASSET = IS_WINDOWS ? "yt-dlp.exe" : "yt-dlp_macos";
const short = (text) => String(text).split(dirname(APP)).join("<app>");

const evidence = { app: short(APP), url: VIDEO };
function done(status, extra = {}) {
  Object.assign(evidence, { status }, extra);
  writeEvidence(`${NAME}-ytdlp.json`, evidence);
  console.log(JSON.stringify(evidence, null, 1));
  console.log(`W8 (yt-dlp on the app's Node): ${status}`);
  process.exit(0);
}

const dir = join(RUNS, "yt-dlp");
const ytDlp = join(dir, ASSET);
try {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(ytDlp)) {
    const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`);
    if (!response.ok) done("skipped", { reason: `downloading yt-dlp answered ${response.status}` });
    writeFileSync(ytDlp, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });
  }
} catch (error) {
  done("skipped", { reason: `downloading yt-dlp failed: ${error.message}` });
}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
const version = spawnSync(ytDlp, ["--version"], { encoding: "utf8", env, timeout: 60_000 });
const node = spawnSync(APP, ["--version"], { encoding: "utf8", env, timeout: 60_000 });
evidence.ytDlpVersion = version.stdout?.trim() ?? null;
evidence.appAsNode = `${node.stdout?.trim() ?? ""}${node.stderr?.trim() ?? ""}` || `exit ${node.status}`;
// How yt-dlp's challenge solver runs the runtime: --permission, and its script on stdin. Recorded on
// its own, since YouTube's bot check can stop yt-dlp before it gets there.
const solver = spawnSync(APP, ["--permission", "-"], {
  encoding: "utf8",
  env,
  timeout: 60_000,
  input: "console.log(JSON.stringify({ node: process.version, permissionModel: typeof process.permission?.has === 'function', fsWrite: process.permission?.has('fs.write') ?? null }))",
});
evidence.solverInvocation = { command: "<app> --permission - (script on stdin)", exitCode: solver.status, stdout: solver.stdout?.trim() ?? "", stderr: (solver.stderr ?? "").trim().slice(0, 300) };
const args = ["--ignore-config", "--no-cache-dir", "--no-js-runtimes", "--js-runtimes", `node:${APP}`, "--simulate", "-v", "--print", "%(id)s|%(duration)s|%(title)s", VIDEO];
const result = spawnSync(ytDlp, args, { encoding: "utf8", env, timeout: 240_000 });
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const lines = output.split(/\r?\n/);
evidence.command = `yt-dlp ${args.map(short).join(" ")}`;
evidence.exitCode = result.status;
evidence.printed = (result.stdout ?? "").trim().split(/\r?\n/).filter((l) => l.startsWith("jNQXAC9IVRw")).slice(0, 2);
evidence.runtimeLines = lines.filter((l) => /js runtime|jsc|challenge|ejs|\bnode\b/i.test(l)).map(short).slice(0, 30);
evidence.errorLines = lines.filter((l) => /^ERROR|WARNING/.test(l)).map(short).slice(0, 15);
const blocked = /Sign in to confirm|not a bot|HTTP Error 429|Unable to download API page|timed out|getaddrinfo|Connection reset/i.test(output);
const usedNode = lines.some((l) => /\[jsc:node\]/.test(l));
if (result.status === 0 && evidence.printed.length > 0) done(usedNode ? "pass" : "fail", usedNode ? {} : { reason: "the verbose log names no node JS runtime" });
done(blocked ? "skipped" : "fail", { reason: blocked ? "YouTube or the network refused this runner" : "yt-dlp failed", tail: lines.slice(-25).map(short) });
