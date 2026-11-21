// The failure page's buttons, which reach main through the shell bridge, and nothing else.
import type { EidolonShell } from "../shared/bridge.ts";

const shell = (globalThis as { eidolonShell?: EidolonShell }).eidolonShell;

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
  const action = button.dataset.action;
  if (action === "retry" || action === "showLogs" || action === "quit") {
    button.addEventListener("click", () => shell?.[action]());
  }
}
