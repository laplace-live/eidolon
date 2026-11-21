// C8b: what a page's own window.close() does to the shell (the close button goes through
// BrowserWindow.close() and hides; a page script takes another path).
import { spawn } from "node:child_process";
import { appPage, connect, finderEnv, launchApp, makeRun, PACKAGED, PACKAGED_APP, processes, recordPid, shellEvents, sleep, waitForEvent, writeEvidence } from "../lib.mjs";
import { join } from "node:path";
const name = process.argv[2] ?? "pkg-c8b";
const run = makeRun(name, { preferredPort: 0, cdpPort: 9333 });
const app = launchApp(run, { packaged: true });
const out = { run: name };
let browser;
try {
  const listening = await waitForEvent(run, (e) => e.event === "home-probe", 60_000);
  const backend = shellEvents(run).find((e) => e.event === "backend-listening");
  browser = await connect(9333);
  const page = await appPage(browser);
  const at = Date.now();
  await page.evaluate(() => window.close()).catch((error) => (out.evaluateError = String(error).split("\n")[0]));
  await sleep(2000);
  out.eventsAfterWindowClose = shellEvents(run).filter((e) => e.at >= at).map((e) => e.event);
  let alive = true;
  try { process.kill(backend.pid, 0); } catch { alive = false; }
  out.backendAlive = alive;
  const secondAt = Date.now();
  const second = spawn(PACKAGED, [], { env: finderEnv(run.file), stdio: "ignore" });
  recordPid(second.pid, `second instance of ${name}`);
  await new Promise((resolve) => second.on("exit", resolve));
  await sleep(1000);
  out.eventsAfterSecondInstance = shellEvents(run).filter((e) => e.at >= secondAt).map((e) => e.event);
} catch (error) {
  out.error = String(error);
} finally {
  await browser?.close().catch(() => {});
  const quitAt = Date.now();
  app.child.kill("SIGTERM");
  const exited = await Promise.race([app.exited, sleep(20_000).then(() => null)]);
  out.quit = { events: shellEvents(run).filter((e) => e.at >= quitAt).map((e) => e.event), stopped: shellEvents(run).find((e) => e.event === "backend-stopped"), appExit: exited?.code };
  out.leftovers = processes(PACKAGED_APP).length;
  writeEvidence(`${name}-results.json`, out);
  console.log(JSON.stringify(out, null, 1));
}
