// Signing and notarization over the base config, for desktop.yml's signed builds only: a tag, or a
// dispatch with `sign`. Credentials come from that job's environment; local and unsigned builds
// never load this file (scripts/package.ts).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The signer names a Windows install accepts updates from, frozen into its app-update.yml: it
 * learns a new list only from an update signed by a name it already accepts.
 */
export const PUBLISHER_NAMES: readonly string[] = ["Sparanoid, Inc.", "LAPLACE Live LLC"];

const UNSIGNED_PE = fileURLToPath(new URL("./.stage/win32-x64/unsigned-pe.json", import.meta.url));

export interface ReleaseConfigOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly unsignedPe?: string;
}

export interface ReleaseConfig {
  readonly extends: string;
  readonly publish: { readonly publisherName: readonly string[] };
  readonly mac: {
    readonly notarize: boolean;
    readonly forceCodeSigning: boolean;
    readonly requirements: string;
    readonly provisioningProfile?: string;
    readonly entitlements?: string;
  };
  readonly win?: {
    readonly azureSignOptions: {
      readonly endpoint: string;
      readonly codeSigningAccountName: string | undefined;
      readonly certificateProfileName: string | undefined;
      readonly publisherName: string;
    };
    readonly forceCodeSigning: boolean;
    readonly signExts: string[];
  };
}

/**
 * The basenames of the stage's unsigned .node and .dll files, Electron's included. Names only: a
 * positive signExts entry wins before any "!" one, so an extension would re-sign onnxruntime's,
 * the VC++ runtime's and Electron's d3dcompiler_47.dll over Microsoft's signatures.
 */
function unsignedPeNames(list: string): string[] {
  if (!existsSync(list)) {
    throw new Error(
      `electron-builder.release.ts: no ${list}, the PE files to sign; stage the backend first ` +
        "(pnpm build:desktop, on Windows)",
    );
  }
  return JSON.parse(readFileSync(list, "utf8")) as string[];
}

/** The overlay for `platform`; Windows' block reads the Azure names from `env`. */
export function releaseConfig({
  platform = process.platform,
  env = process.env,
  unsignedPe = UNSIGNED_PE,
}: ReleaseConfigOptions = {}): ReleaseConfig {
  const provisioningProfile = env.APPLE_PROVISIONING_PROFILE?.trim() || undefined;
  return {
    extends: "./electron-builder.yml",
    // Deep-merged into the base's publish block.
    publish: { publisherName: PUBLISHER_NAMES },
    mac: {
      // Credentials from APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER; notarizing staples.
      notarize: true,
      forceCodeSigning: true,
      // electron-builder stamps it on every file it signs, so it names no identifier.
      requirements: "resources/designated-requirement.mac",
      ...(provisioningProfile === undefined
        ? {}
        : {
            provisioningProfile,
            entitlements: "resources/entitlements.mac.release.plist",
          }),
    },
    // The schema requires the account and profile names, and only the Windows leg's environment
    // has them.
    ...(platform === "win32" && {
      win: {
        azureSignOptions: {
          endpoint: "https://eus.codesigning.azure.net",
          codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT_NAME,
          certificateProfileName: env.AZURE_CERTIFICATE_PROFILE_NAME,
          // Schema-required but single-valued: publish.publisherName is what app-update.yml gets.
          publisherName: PUBLISHER_NAMES[0] as string,
        },
        forceCodeSigning: true,
        signExts: unsignedPeNames(unsignedPe),
      },
    }),
  };
}

// electron-builder calls a default function at load, so importing this file reads no stage.
export default (): ReleaseConfig => releaseConfig();
