// Spike-only: the variable names local-smoke's childEnv drops (credentials, settings, provider base
// URLs and fields), so a spike backend never inherits a real key, a Qdrant host or a provider base
// from the owner's login shell. Written to drop-names.json beside the shell's main.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = join(import.meta.dirname, "..", "..", "..");
const { CREDENTIALS, SETTINGS } = await import(join(REPO, "packages/config/src/index.ts"));
const { PROVIDERS } = await import(join(REPO, "packages/providers/src/catalog.ts"));
const names = new Set<string>([
  ...CREDENTIALS,
  ...SETTINGS.map((row: { env: string }) => row.env),
  ...PROVIDERS.flatMap((p: { baseUrlEnv: string | null; fields?: { env: string }[] }) => [
    ...(p.baseUrlEnv === null ? [] : [p.baseUrlEnv]),
    ...(p.fields ?? []).map((f) => f.env),
  ]),
]);
const sorted = [...names].sort();
writeFileSync(join(import.meta.dirname, "..", "app", "drop-names.json"), `${JSON.stringify(sorted, null, 1)}\n`);
console.log(`${sorted.length} names`);
