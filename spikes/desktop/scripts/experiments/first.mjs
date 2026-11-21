// First light: launch (unpackaged unless --packaged), wait for Home, screenshot, quit with SIGTERM.
import { appPage, connect, launchApp, makeRun, shellEvents, sleep, waitForEvent, EVIDENCE } from "../lib.mjs";
import { join } from "node:path";
const packaged = process.argv.includes("--packaged");
const name = process.argv[2] ?? "first";
const run = makeRun(name, { preferredPort: 17860, cdpPort: 9333 });
const app = launchApp(run, { packaged });
console.log("app pid", app.child.pid);
const probe = await waitForEvent(run, (e) => e.event === "home-probe" || e.event === "backend-failed", 60_000);
console.log("probe", JSON.stringify(probe));
try {
  const browser = await connect(9333);
  const page = await appPage(browser);
  console.log("page", page.url());
  await sleep(1500);
  await page.screenshot({ path: join(EVIDENCE, `${name}-home.png`) });
  await browser.close();
} catch (error) {
  console.log("cdp error", error.message);
}
app.child.kill("SIGTERM");
const exit = await Promise.race([app.exited, sleep(25_000).then(() => null)]);
console.log("app exit", JSON.stringify(exit));
for (const e of shellEvents(run)) if (!["forward", "forward-headers", "console", "permission-check"].includes(e.event)) console.log(e.sinceLaunch, e.event, JSON.stringify(e).slice(0, 300));
console.log("console:", shellEvents(run).filter((e) => e.event === "console").map((e) => `${e.level}: ${e.message}`).join("\n"));
console.log("output:", app.output().slice(0, 2000));
