// The job's verdict from the evidence the other steps wrote: one line per check, written to
// <evidence>/summary-<platform>.json, and exit 1 when a required check failed or never ran. W8 is
// optional and never fails the job.
// usage: node scripts/report.mjs windows|macos
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE, writeEvidence } from "./lib.mjs";

const platform = process.argv[2];
function read(name) {
  const path = join(EVIDENCE, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
/** A check that a step script records as the file's own status. */
const step = (file) => ({ status: read(file)?.status ?? "not run", evidence: file });
/** A check that checks.mjs or mac-verify.mjs records under `checks`. */
function within(file, id) {
  const result = read(file);
  return { status: result?.checks?.[id]?.status ?? (result?.fatal ? "fail" : "not run"), evidence: file };
}

const checks =
  platform === "windows"
    ? {
        W1: step("windows-unsigned-install.json"),
        W2: within("installed-results.json", "W2"),
        W3: within("installed-results.json", "W3"),
        W4: within("installed-results.json", "W4"),
        W5: within("installed-results.json", "W5"),
        W6: within("installed-results.json", "W6"),
        W7: step("windows-unsigned-uninstall.json"),
        W8: step("installed-ytdlp.json"),
        S1: step("windows-signed-signatures.json"),
        S2: within("signed-results.json", "S2"),
      }
    : {
        M1: within("mac-signature.json", "M1"),
        M2: within("mac-signature.json", "M2"),
        M3: within("mac-signature.json", "M3"),
        M4: within("mac-signature.json", "M4"),
        M5: within("mac-signature.json", "M5"),
        M6: within("signed-results.json", "M6"),
      };
writeEvidence(`summary-${platform}.json`, checks);
for (const [id, { status, evidence }] of Object.entries(checks)) console.log(`${id}: ${status} (${evidence})`);
const failed = Object.entries(checks).filter(([id, { status }]) => id !== "W8" && status !== "pass");
if (failed.length > 0) console.log(`failed: ${failed.map(([id]) => id).join(", ")}`);
process.exit(failed.length > 0 ? 1 : 0);
