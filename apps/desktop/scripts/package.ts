// `bun run package:desktop`: electron-builder on dist/ and the staged backend, for this machine, into
// apps/desktop/.out. Unsigned: ad hoc on macOS, never a keychain identity, at version 0.0.0-dev.
// Arguments after it go to electron-builder, such as `-c.compression=store`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const DESKTOP = resolve(import.meta.dirname, "..");
const PAYLOAD = join(".stage", `${process.platform}-${process.arch}`, "eidolon");

if (!existsSync(join(DESKTOP, "dist", "main", "index.js"))) {
  console.error(
    "package:desktop: apps/desktop/dist has no build; run `bun run build:desktop` first",
  );
  process.exit(1);
}
if (!existsSync(join(DESKTOP, PAYLOAD))) {
  console.warn(`package:desktop: no backend in apps/desktop/${PAYLOAD}; the app will start none`);
}

const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
const packaged = spawnSync(
  process.execPath,
  [
    cli,
    "--publish",
    "never",
    // On the command line, never in electron-builder.yml, which the release config extends.
    "-c.mac.identity=-",
    "-c.extraMetadata.version=0.0.0-dev",
    ...process.argv.slice(2),
  ],
  {
    cwd: DESKTOP,
    stdio: "inherit",
    // Otherwise electron-builder signs with any Developer ID identity in the keychain.
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  },
);
process.exit(packaged.status ?? 1);
