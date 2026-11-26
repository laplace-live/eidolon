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
const LISTED = ["Eidolon_wer.dll", "ffmpeg.dll", "lancedb.win32-x64-msvc.node", "libvips-42.dll"];
const scratch = mkdtempSync(join(tmpdir(), "eidolon-release-config-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A stage's unsigned-pe.json holding `names`. */
function unsignedList(names: readonly string[]): string {
  const file = join(mkdtempSync(join(scratch, "stage-")), "unsigned-pe.json");
  writeFileSync(file, `${JSON.stringify(names, null, 2)}\n`);
  return file;
}

describe("the release overlay", () => {
  test("extends the base, and lists both of the org's signers for Windows installs to accept", () => {
    const config = overlay.releaseConfig({ platform: "darwin" });
    expect(config.extends).toBe("./electron-builder.yml");
    expect(config.publish).toEqual({ publisherName: ["Sparanoid, Inc.", "LAPLACE Live LLC"] });
  });

  test("notarizes on macOS, refuses to package unsigned, and stamps the org's requirement", () => {
    const { mac } = overlay.releaseConfig({ platform: "darwin" });
    expect(mac).toEqual({
      notarize: true,
      forceCodeSigning: true,
      requirements: "resources/designated-requirement.mac",
    });
    expect(existsSync(join(DESKTOP, mac.requirements))).toBe(true);
  });

  test("adds no Windows block off Windows, where no Azure name is set, and reads no stage", () => {
    const config = overlay.releaseConfig({
      platform: "darwin",
      env: {},
      unsignedPe: join(scratch, "missing", "unsigned-pe.json"),
    });
    expect(config).not.toHaveProperty("win");
  });

  test("on Windows, signs through Azure as the first signer and signs exactly the listed files", () => {
    const { win } = overlay.releaseConfig({
      platform: "win32",
      env: AZURE,
      unsignedPe: unsignedList(LISTED),
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
      unsignedPe: unsignedList([]),
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

  // On Windows the default reads this checkout's stage, which a test run needn't have.
  test.skipIf(process.platform === "win32")(
    "exports what electron-builder calls: this machine's",
    () => {
      expect(overlay.default()).toEqual(overlay.releaseConfig());
    },
  );
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
      azureSignOptions: base.win?.azureSignOptions,
      signtoolOptions: base.win?.signtoolOptions,
      forceCodeSigning: base.forceCodeSigning,
    }).toEqual({});
  });

  test.skipIf(process.platform === "win32")(
    "merges a dispatch's version and feed over the overlay and the base, and passes the schema",
    async () => {
      const { getConfig, validateConfiguration } = loader();
      const config = await getConfig(DESKTOP, "electron-builder.release.ts", {
        extraMetadata: { version: "0.0.1" },
        publish: { url: "http://127.0.0.1:8765/" },
      });
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
        },
      });
      expect(config.win).not.toHaveProperty("azureSignOptions");
      await validateConfiguration(config, { isEnabled: false });
    },
  );

  test("passes the schema with the Windows block, given the Azure names", async () => {
    const { getConfig, doMergeConfigs, validateConfiguration } = loader();
    const base = await getConfig(DESKTOP, "electron-builder.yml", null);
    const config = doMergeConfigs([
      base,
      overlay.releaseConfig({ platform: "win32", env: AZURE, unsignedPe: unsignedList(LISTED) }),
    ]);
    expect(config.win).toMatchObject({ target: [{ target: "nsis" }], signExts: LISTED });
    await validateConfiguration(config, { isEnabled: false });
  });
});
