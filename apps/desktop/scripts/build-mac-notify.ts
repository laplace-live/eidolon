// Compiles apps/desktop/native/mac-notify.m into dist/native/mac_notify.node on macOS.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DESKTOP = resolve(import.meta.dirname, "..");
const SOURCE = join(DESKTOP, "native", "mac-notify.m");
const OUTPUT = join(DESKTOP, "dist", "native", "mac_notify.node");

export function macNotifyOutput(): string {
  return OUTPUT;
}

export function buildMacNotify(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "darwin") return null;
  mkdirSync(dirname(OUTPUT), { recursive: true });
  const args = [
    "-ObjC",
    "-fobjc-arc",
    "-arch",
    "arm64",
    "-mmacosx-version-min=13.0",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-framework",
    "Foundation",
    "-framework",
    "UserNotifications",
    "-framework",
    "Intents",
    SOURCE,
    "-o",
    OUTPUT,
  ];
  const run = spawnSync("/usr/bin/clang", args, { encoding: "utf8" });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`clang failed building mac-notify (${run.status}):\n${run.stderr}`);
  }
  return OUTPUT;
}

if (import.meta.main) {
  const built = buildMacNotify();
  console.log(built === null ? "mac-notify skipped off macOS" : `built ${built}`);
}
