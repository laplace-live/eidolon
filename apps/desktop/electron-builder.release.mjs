// Signing and notarization over the base config, for desktop.yml's signed builds only: a tag, or a
// dispatch with `sign`. Credentials come from that job's environment; local and unsigned builds
// never load this file (scripts/package.ts).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The signer names a Windows install accepts updates from, frozen into its app-update.yml: it
 * learns a new list only from an update signed by a name it already accepts.
 */
export const PUBLISHER_NAMES = ["Sparanoid, Inc.", "LAPLACE Live LLC"];

const UNSIGNED_PE = fileURLToPath(new URL("./.stage/win32-x64/unsigned-pe.json", import.meta.url));

/**
 * The basenames of the stage's unsigned .node and .dll files, Electron's included. Names only: a
 * positive signExts entry wins before any "!" one, so an extension would re-sign onnxruntime's,
 * the VC++ runtime's and Electron's d3dcompiler_47.dll over Microsoft's signatures.
 */
function unsignedPeNames(list) {
  if (!existsSync(list)) {
    throw new Error(
      `electron-builder.release.mjs: no ${list}, the PE files to sign; stage the backend first ` +
        "(pnpm build:desktop, on Windows)",
    );
  }
  return JSON.parse(readFileSync(list, "utf8"));
}

/** The overlay for `platform`; Windows' block reads the Azure names from `env`. */
export function releaseConfig({
  platform = process.platform,
  env = process.env,
  unsignedPe = UNSIGNED_PE,
} = {}) {
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
          publisherName: PUBLISHER_NAMES[0],
        },
        forceCodeSigning: true,
        signExts: unsignedPeNames(unsignedPe),
      },
    }),
  };
}

// electron-builder calls a default function at load, so importing this file reads no stage.
export default () => releaseConfig();
