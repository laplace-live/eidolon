// Mini run: does the fake microphone carry the WAV? Starts a chat and a call, reads the mic
// source's energy and the fakes' VAD commits, hangs up and quits.
import { join } from "node:path";
import { appPage, connect, fakeLog, lastFakeSeq, launchApp, makeRun, RUNS, shellEvents, sleep, waitForEvent } from "../lib.mjs";
import { fakeMicWav } from "../wav.mjs";
const packaged = process.argv.includes("--packaged");
const unsandboxed = process.argv.includes("--unsandboxed-audio");
const name = process.argv[2];
const wav = join(RUNS, `${name}-mic.wav`);
fakeMicWav(wav);
const run = makeRun(name, { preferredPort: 0, cdpPort: 9333, fakeMicWav: wav, audioServiceUnsandboxed: unsandboxed });
const app = launchApp(run, { packaged });
let browser;
try {
  await waitForEvent(run, (e) => e.event === "home-probe", 60_000);
  browser = await connect(9333);
  const page = await appPage(browser);
  const { id } = await page.evaluate(async () => (await fetch("/api/local/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ participants: ["milky-green"] }) })).json());
  await page.goto(`eidolon-app://app/chats/${id}`);
  await page.evaluate(() => {
    window.__pcs = [];
    const O = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends O { constructor(...a) { super(...a); window.__pcs.push(this); } };
  });
  const personas = await page.evaluate(async () => (await fetch("/api/local/personas")).json());
  const persona = personas.personas.find((p) => p.id === "milky-green");
  const short = persona.shortName?.trim() || persona.name;
  await page.getByRole("log", { name: "Conversation", exact: true }).getByText("晚上好呀", { exact: false }).first().waitFor({ timeout: 30_000 });
  const seq = lastFakeSeq();
  await page.getByRole("button", { name: "Call", exact: true }).click();
  await page.getByRole("region", { name: `Call with ${short}`, exact: true }).waitFor({ timeout: 20_000 });
  await sleep(15_000);
  const stats = await page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs) {
      const r = await pc.getStats();
      r.forEach((s) => { if (s.type === "media-source" && s.kind === "audio") out.push({ energy: s.totalAudioEnergy, seconds: s.totalSamplesDuration, level: s.audioLevel }); });
    }
    return out;
  });
  const realtime = fakeLog(seq).filter((e) => e.kind.startsWith("realtime") || (e.kind === "speech"));
  console.log(JSON.stringify({ unsandboxed, stats, realtime: realtime.map((e) => `${e.kind} ${e.commits ?? ""} ${e.input ?? e.transcript ?? ""}`) }, null, 1));
  await page.getByRole("button", { name: "Hang Up", exact: true }).click().catch(() => {});
  await sleep(1000);
} catch (error) {
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  app.child.kill("SIGTERM");
  await Promise.race([app.exited, sleep(20_000)]);
  console.log("exit", app.child.exitCode, shellEvents(run).filter((e) => e.event === "backend-stopped").map((e) => e.code));
}
