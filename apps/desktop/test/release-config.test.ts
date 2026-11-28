// electron-builder.release.ts, the signing overlay desktop.yml packages a release with: what it
// computes for each platform, and what electron-builder's own loader and schema make of it over the
// base config, with a signed dispatch's version and feed on the command line.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import * as overlay from "../electron-builder.release.ts";

const DESKTOP = resolve(import.meta.dirname, "..");

type Config = Record<string, any>;

/** electron-builder's config loading, found through its package as its CLI loads it. */
interface Loader {
  getConfig(
    projectDir: string,
    configPath: string,
    configFromOptions: Config | null,
  ): Promise<Config>;
  doMergeConfigs(configs: Config[]): Config;
  validateConfiguration(config: Config, debugLogger: { isEnabled: boolean }): Promise<void>;
}

function loader(): Loader {
  const builder = createRequire(join(DESKTOP, "package.json")).resolve(
    "electron-builder/package.json",
  );
  return createRequire(builder)("app-builder-lib/out/util/config/config.js");
}

const AZURE = { AZURE_SIGNING_ACCOUNT_NAME: "account", AZURE_CERTIFICATE_PROFILE_NAME: "profile" };
const MAC_LISTED = [
  "Frameworks/Electron Framework.framework",
  "Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  "Frameworks/LAPLACE Eidolon Helper (GPU).app",
  "Frameworks/LAPLACE Eidolon Helper (GPU).app/Contents/MacOS/LAPLACE Eidolon Helper (GPU)",
  "MacOS/LAPLACE Eidolon",
  "Resources/eidolon/node_modules/@zvec/bindings-darwin-arm64/zvec_node_binding.node",
  "Resources/native/mac_notify.node",
];
const LISTED = ["Eidolon_wer.dll", "ffmpeg.dll", "libvips-42.dll", "zvec_node_binding.node"];
const MAC_STAGE = join(DESKTOP, ".stage", "darwin-arm64", "mac-sign.json");
const scratch = mkdtempSync(join(tmpdir(), "eidolon-release-config-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A stage file holding `items` as JSON. */
function stageList(name: string, items: readonly string[]): string {
  const file = join(mkdtempSync(join(scratch, "stage-")), name);
  writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`);
  return file;
}

describe("the release overlay", () => {
  test("extends the base, and lists both of the org's signers for Windows installs to accept", () => {
    const config = overlay.releaseConfig({
      platform: "darwin",
      macSign: stageList("mac-sign.json", MAC_LISTED),
    });
    expect(config.extends).toBe("./electron-builder.yml");
    expect(config.publish).toEqual({ publisherName: ["Sparanoid, Inc.", "LAPLACE Live LLC"] });
  });

  test("notarizes on macOS, refuses to package unsigned, stamps the org's requirement, and ignores non-Mach-O paths", () => {
    const { mac } = overlay.releaseConfig({
      platform: "darwin",
      macSign: stageList("mac-sign.json", MAC_LISTED),
    });
    expect(mac).toEqual({
      notarize: true,
      forceCodeSigning: true,
      requirements: "resources/designated-requirement.mac",
      signIgnore: overlay.macSignIgnore(MAC_LISTED),
    });
    expect(existsSync(join(DESKTOP, mac.requirements))).toBe(true);
    const ignore = (mac.signIgnore ?? []).map((pattern) => new RegExp(pattern));
    const skipped = (file: string) => ignore.some((re) => re.test(file));
    const app = "/tmp/.out/mac-arm64/LAPLACE Eidolon.app";
    expect(skipped(app)).toBe(false);
    for (const rel of MAC_LISTED) {
      expect([rel, skipped(`${app}/Contents/${rel}`)]).toEqual([rel, false]);
    }
    for (const ignored of [
      "Resources/app.asar",
      "Resources/Assets.car",
      "embedded.provisionprofile",
      "Frameworks/Electron Framework.framework/Resources/en.lproj/locale.pak",
      "Frameworks/Electron Framework.framework/Versions/Current/Electron Framework",
      "Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/locale.pak",
      "Resources/eidolon/data/models/silero_vad.onnx",
      "MacOS/LAPLACE Eidolon.extra",
    ]) {
      expect([ignored, skipped(`${app}/Contents/${ignored}`)]).toEqual([ignored, true]);
    }
  });

  test("on macOS, an empty list ignores everything under Contents/ while keeping the outer .app", () => {
    const { mac } = overlay.releaseConfig({
      platform: "darwin",
      macSign: stageList("mac-sign.json", []),
    });
    const [pattern] = mac.signIgnore ?? [];
    const re = new RegExp(pattern as string);
    expect(re.test("/tmp/LAPLACE Eidolon.app")).toBe(false);
    expect(re.test("/tmp/LAPLACE Eidolon.app/Contents/Resources/app.asar")).toBe(true);
  });

  test("on macOS, fails without the stage's list, naming it and how to make it", () => {
    const missing = join(scratch, "unstaged", "mac-sign.json");
    expect(() => overlay.releaseConfig({ platform: "darwin", macSign: missing })).toThrow(
      `${missing}`,
    );
    expect(() => overlay.releaseConfig({ platform: "darwin", macSign: missing })).toThrow(
      "pnpm build:desktop",
    );
  });

  test("adds no Windows block off Windows and reads only the target platform's stage", () => {
    const darwin = overlay.releaseConfig({
      platform: "darwin",
      env: {},
      macSign: stageList("mac-sign.json", MAC_LISTED),
      unsignedPe: join(scratch, "missing", "unsigned-pe.json"),
    });
    expect(darwin).not.toHaveProperty("win");
    const linux = overlay.releaseConfig({
      platform: "linux",
      env: {},
      macSign: join(scratch, "missing", "mac-sign.json"),
      unsignedPe: join(scratch, "missing", "unsigned-pe.json"),
    });
    expect(linux).not.toHaveProperty("win");
    expect(linux.mac).not.toHaveProperty("signIgnore");
  });

  test("on Windows, signs through Azure as the first signer and signs exactly the listed files", () => {
    const { win } = overlay.releaseConfig({
      platform: "win32",
      env: AZURE,
      macSign: join(scratch, "missing", "mac-sign.json"),
      unsignedPe: stageList("unsigned-pe.json", LISTED),
    });
    expect(win).toEqual({
      azureSignOptions: {
        endpoint: "https://eus.codesigning.azure.net",
        codeSigningAccountName: "account",
        certificateProfileName: "profile",
        publisherName: "Sparanoid, Inc.",
      },
      forceCodeSigning: true,
      signExts: LISTED,
    });
  });

  test("on Windows, an empty list signs only what electron-builder signs anyway: the .exe files", () => {
    const { win } = overlay.releaseConfig({
      platform: "win32",
      env: AZURE,
      unsignedPe: stageList("unsigned-pe.json", []),
    });
    expect(win?.signExts).toEqual([]);
  });

  test("on Windows, fails without the stage's list, naming it and how to make it", () => {
    const missing = join(scratch, "unstaged", "unsigned-pe.json");
    expect(() =>
      overlay.releaseConfig({ platform: "win32", env: AZURE, unsignedPe: missing }),
    ).toThrow(`${missing}`);
    expect(() =>
      overlay.releaseConfig({ platform: "win32", env: AZURE, unsignedPe: missing }),
    ).toThrow("pnpm build:desktop");
  });

  // On macOS and Windows the default reads this checkout's stage, which a test run needn't have.
  test.skipIf(
    process.platform === "win32" || (process.platform === "darwin" && !existsSync(MAC_STAGE)),
  )("exports what electron-builder calls: this machine's", () => {
    expect(overlay.default()).toEqual(overlay.releaseConfig());
  });
});

describe("electron-builder's loader", () => {
  // Unsigned builds pass -c.mac.identity=- on the command line (scripts/package.ts): an identity in
  // the base would replace the release's Developer ID.
  test("finds no signing identity in the base config, which the overlay would inherit", async () => {
    const base = await loader().getConfig(DESKTOP, "electron-builder.yml", null);
    expect({
      identity: base.mac?.identity,
      notarize: base.mac?.notarize,
      requirements: base.mac?.requirements,
      signIgnore: base.mac?.signIgnore,
      azureSignOptions: base.win?.azureSignOptions,
      signtoolOptions: base.win?.signtoolOptions,
      forceCodeSigning: base.forceCodeSigning,
    }).toEqual({});
    expect(base.electronLanguages).toEqual(["en-US", "zh-CN"]);
  });

  test("passes the schema with the macOS signIgnore overlay merged over the base", async () => {
    const { getConfig, doMergeConfigs, validateConfiguration } = loader();
    const base = await getConfig(DESKTOP, "electron-builder.yml", null);
    const config = doMergeConfigs([
      base,
      overlay.releaseConfig({
        platform: "darwin",
        macSign: stageList("mac-sign.json", MAC_LISTED),
      }),
      { extraMetadata: { version: "0.0.1" }, publish: { url: "http://127.0.0.1:8765/" } },
    ]);
    expect(config).toMatchObject({
      appId: "live.laplace.eidolon",
      extraMetadata: { name: "eidolon", version: "0.0.1" },
      publish: {
        provider: "generic",
        url: "http://127.0.0.1:8765/",
        useMultipleRangeRequest: false,
        publisherName: ["Sparanoid, Inc.", "LAPLACE Live LLC"],
      },
      mac: {
        hardenedRuntime: true,
        notarize: true,
        forceCodeSigning: true,
        requirements: "resources/designated-requirement.mac",
        signIgnore: overlay.macSignIgnore(MAC_LISTED),
      },
    });
    expect(config.win).not.toHaveProperty("azureSignOptions");
    await validateConfiguration(config, { isEnabled: false });
  });

  test.skipIf(
    process.platform === "win32" || (process.platform === "darwin" && !existsSync(MAC_STAGE)),
  )(
    "loads electron-builder.release.ts directly through getConfig when this checkout is staged",
    async () => {
      const { getConfig, validateConfiguration } = loader();
      const config = await getConfig(DESKTOP, "electron-builder.release.ts", {
        extraMetadata: { version: "0.0.1" },
        publish: { url: "http://127.0.0.1:8765/" },
      });
      await validateConfiguration(config, { isEnabled: false });
    },
  );

  test("passes the schema with the Windows block, given the Azure names", async () => {
    const { getConfig, doMergeConfigs, validateConfiguration } = loader();
    const base = await getConfig(DESKTOP, "electron-builder.yml", null);
    const config = doMergeConfigs([
      base,
      overlay.releaseConfig({
        platform: "win32",
        env: AZURE,
        unsignedPe: stageList("unsigned-pe.json", LISTED),
      }),
    ]);
    expect(config.win).toMatchObject({ target: [{ target: "nsis" }], signExts: LISTED });
    await validateConfiguration(config, { isEnabled: false });
  });

  test("applies provisioningProfile and release entitlements only when APPLE_PROVISIONING_PROFILE is set", async () => {
    const profilePath = join(scratch, "eidolon.provisionprofile");
    const macSign = stageList("mac-sign.json", MAC_LISTED);
    const withoutProfile = overlay.releaseConfig({
      platform: "darwin",
      env: { APPLE_PROVISIONING_PROFILE: "  " },
      macSign,
    });
    expect(withoutProfile.mac.provisioningProfile).toBeUndefined();
    expect(withoutProfile.mac.entitlements).toBeUndefined();

    const withProfile = overlay.releaseConfig({
      platform: "darwin",
      env: { APPLE_PROVISIONING_PROFILE: profilePath },
      macSign,
    });
    expect(withProfile.mac.provisioningProfile).toBe(profilePath);
    expect(withProfile.mac.entitlements).toBe("resources/entitlements.mac.release.plist");

    const { getConfig, doMergeConfigs, validateConfiguration } = loader();
    const base = await getConfig(DESKTOP, "electron-builder.yml", null);
    const merged = doMergeConfigs([base, withProfile]);
    expect(merged.mac).toMatchObject({
      provisioningProfile: profilePath,
      entitlements: "resources/entitlements.mac.release.plist",
    });
    await validateConfiguration(merged, { isEnabled: false });
  });

  test("passes the schema for unsigned CI's stored NSIS build without a differential blockmap", async () => {
    const { getConfig, validateConfiguration } = loader();
    const config = await getConfig(DESKTOP, "electron-builder.yml", {
      compression: "store",
      nsis: { differentialPackage: false },
    });
    expect(config.compression).toBe("store");
    expect(config.nsis).toMatchObject({
      include: "resources/installer.nsh",
      differentialPackage: false,
    });
    await validateConfiguration(config, { isEnabled: false });
  });
});
