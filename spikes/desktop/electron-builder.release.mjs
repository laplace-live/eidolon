// Signing and notarization over the base config, as persona's apps/desktop/electron-builder.release.mjs.
// Credentials come from CI's environment, under persona CI's names; never used for unsigned builds.
import { existsSync, readFileSync } from "node:fs";

// Signer CNs a Windows install accepts updates from, frozen into its app-update.yml: both of the
// org's identities from the first release.
const publisherName = ["Sparanoid, Inc.", "LAPLACE Live LLC"];

const azureSignOptions = {
  endpoint: "https://eus.codesigning.azure.net",
  codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT_NAME,
  certificateProfileName: process.env.AZURE_CERTIFICATE_PROFILE_NAME,
  // Schema-required but single-valued; publish.publisherName overrides it for app-update.yml.
  publisherName: publisherName[0],
};

/**
 * The payload's unsigned .node and .dll files, by name, as scripts/stage.mjs found them. Only names:
 * a positive signExts entry wins before any "!" one, so [".node", ".dll"] would re-sign ORT's and the
 * VC++ DLLs over Microsoft's signatures, and a bare ".dll" would reach Electron's own DLLs.
 */
function unsignedPe() {
  const list = new URL("./.stage/win32-x64/unsigned-pe.json", import.meta.url);
  if (!existsSync(list)) throw new Error("no .stage/win32-x64/unsigned-pe.json: run scripts/stage.mjs first");
  return JSON.parse(readFileSync(list, "utf8"));
}

export default {
  extends: "./electron-builder.yml",
  // Deep-merged into the base publish block.
  publish: { publisherName },
  mac: {
    // Credentials via APPLE_API_KEY(_ID)/APPLE_API_ISSUER; electron-builder staples the app.
    notarize: true,
    forceCodeSigning: true,
    // Accepts either of the org's Apple teams.
    requirements: "resources/requirements.mac.txt",
  },
  // Windows builds only: the schema requires the account and profile, and only the Windows leg's
  // environment carries them.
  ...(process.platform === "win32" && {
    win: {
      azureSignOptions,
      forceCodeSigning: true,
      signExts: unsignedPe(),
    },
  }),
};
