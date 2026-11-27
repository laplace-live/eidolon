// electron-builder afterPack hook: rewrites Mach-O LC_UUIDs on the main and helper executables
// of the packaged macOS app before code signing so macOS Local Network Privacy isolates it from
// other Electron apps built against the same stock Electron binaries.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveMachoUuid, formatUuid, rewriteMachoExecuteUuid } from "./macho.ts";
import { parseAppleXmlPlist } from "./signed-check.ts";

interface BundleMeta {
  readonly bundleId: string;
  readonly version?: string;
  readonly executable: string;
}

function readBundleMeta(plistPath: string): BundleMeta {
  const parsed = parseAppleXmlPlist(readFileSync(plistPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Info.plist object at ${plistPath}`);
  }
  const record = parsed as Record<string, unknown>;
  const bundleId = record.CFBundleIdentifier;
  const executable = record.CFBundleExecutable;
  const version = record.CFBundleShortVersionString;
  if (typeof bundleId !== "string" || bundleId.trim() === "") {
    throw new Error(`Missing CFBundleIdentifier in ${plistPath}`);
  }
  if (typeof executable !== "string" || executable.trim() === "") {
    throw new Error(`Missing CFBundleExecutable in ${plistPath}`);
  }
  return {
    bundleId,
    executable,
    ...(typeof version === "string" && version.trim() !== "" ? { version } : {}),
  };
}

/**
 * Rewrites the 64-bit MH_EXECUTE LC_UUIDs of `appBundlePath` and all helper `.app` bundles under
 * `Contents/Frameworks/` (leaving `.framework` libraries untouched) and returns the new UUIDs by
 * bundle-relative path.
 */
export function rewriteAppBundleUuids(
  appBundlePath: string,
  electronVersion: string,
): Map<string, string> {
  const rewritten = new Map<string, string>();
  const rewriteBundle = (relBundle: string, tag: string, fallbackVersion: string): string => {
    const meta = readBundleMeta(join(appBundlePath, relBundle, "Contents", "Info.plist"));
    const version = meta.version ?? fallbackVersion;
    const relExe = join(relBundle, "Contents", "MacOS", meta.executable);
    const uuid = deriveMachoUuid(`${meta.bundleId}@${version}+electron-${electronVersion}:${tag}`);
    rewriteMachoExecuteUuid(join(appBundlePath, relExe), uuid);
    rewritten.set(relExe, formatUuid(uuid));
    return version;
  };

  const appVersion = rewriteBundle("", "main", "0.0.0");

  const frameworksDir = join(appBundlePath, "Contents", "Frameworks");
  if (existsSync(frameworksDir)) {
    const helperApps = readdirSync(frameworksDir)
      .filter((name) => name.endsWith(".app"))
      .sort();
    for (const helperAppName of helperApps) {
      rewriteBundle(join("Contents", "Frameworks", helperAppName), helperAppName, appVersion);
    }
  }

  return rewritten;
}

export default async function afterPack(context: {
  readonly electronPlatformName: string;
  readonly appOutDir: string;
  readonly packager: {
    readonly appInfo: { readonly productFilename: string };
    readonly config: { readonly electronVersion?: string };
  };
}): Promise<void> {
  if (context.electronPlatformName !== "darwin") return;
  const appBundle = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const electronVersion = context.packager.config.electronVersion ?? "unknown";
  rewriteAppBundleUuids(appBundle, electronVersion);
}
