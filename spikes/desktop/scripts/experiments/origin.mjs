// D2's claim: the origin's storage survives a new backend port. Reads the marker an earlier launch
// (another port) left in eidolon-app://app's localStorage, on a launch bound to a random port.
import { appPage, connect, launchApp, makeRun, shellEvents, sleep, waitForEvent, writeEvidence } from "../lib.mjs";
const name = process.argv[2] ?? "pkg-origin";
const run = makeRun(name, { preferredPort: 0, cdpPort: 9333 });
const app = launchApp(run, { packaged: true });
const out = { run: name };
let browser;
try {
  await waitForEvent(run, (e) => e.event === "home-probe", 60_000);
  out.port = shellEvents(run).find((e) => e.event === "backend-listening").port;
  browser = await connect(9333);
  const page = await appPage(browser);
  out.page = await page.evaluate(() => ({ origin: location.origin, marker: localStorage.getItem("spike-marker"), keys: Object.keys(localStorage), cookie: document.cookie, locked: /Open Eidolon from Your Terminal/.test(document.body.innerText) }));
} finally {
  await browser?.close().catch(() => {});
  app.child.kill("SIGTERM");
  await Promise.race([app.exited, sleep(20_000)]);
  writeEvidence(`${name}-results.json`, out);
  console.log(JSON.stringify(out));
}
