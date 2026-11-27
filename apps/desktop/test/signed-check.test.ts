// signed-check.ts's verdicts on what codesign, spctl, stapler, csreq and Get-AuthenticodeSignature
// print, as they print it. macOS's are shaped on a real Developer ID Electron app, the Phase 0 spike's
// ad-hoc build and a binary signed ad hoc with the requirement file; Windows' on the objects the
// script's PowerShell pipeline emits through ConvertTo-Json, for Electron 45.4.1's own PE files, the
// payload's and the NSIS setup's.
import { describe, expect, test } from "vitest";
import {
  type Authenticode,
  authenticodeScript,
  codeSignature,
  designatedRequirement,
  ensureNoWindowsInstall,
  gatekeeperCheck,
  macBundleLocalNetworkChecks,
  macSignerCheck,
  nativeCheck,
  parseAppleXmlPlist,
  parseAuthenticode,
  payloadNativesCheck,
  presenceCheck,
  provisioningProfileChecks,
  requiredInInstall,
  requirementCheck,
  signatureChecks,
  stapleCheck,
  type ToolRun,
  verifyCheck,
} from "../scripts/signed-check.ts";

const APP = "/Users/runner/work/eidolon/eidolon/apps/desktop/.out/mac-arm64/LAPLACE Eidolon.app";
const NATIVE = `${APP}/Contents/Resources/eidolon/node_modules/@zvec/bindings-darwin-arm64/zvec_node_binding.node`;
const ORG_REQUIREMENT =
  'designated => anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and (certificate leaf[subject.OU] = B5483RCL5H or certificate leaf[subject.OU] = "9H3CCD4YMM")';

const ok = (output: string): ToolRun => ({ status: 0, output });

/** `codesign -dvvv` of the app, signed with the Developer ID, notarized and stapled. */
const APP_SIGNATURE = `Executable=${APP}/Contents/MacOS/LAPLACE Eidolon
Identifier=live.laplace.eidolon
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=652 flags=0x10000(runtime) hashes=9+7 location=embedded
Hash type=sha256 size=32
CandidateCDHash sha256=5f0c2b3c8d7f4a1e9b6d2c0a8e7f6d5c4b3a2918
CandidateCDHashFull sha256=5f0c2b3c8d7f4a1e9b6d2c0a8e7f6d5c4b3a29187e6d5c4b3a2918f7e6d5c4b3
Hash choices=sha256
CMSDigest=5f0c2b3c8d7f4a1e9b6d2c0a8e7f6d5c4b3a29187e6d5c4b3a2918f7e6d5c4b3
CMSDigestType=2
CDHash=5f0c2b3c8d7f4a1e9b6d2c0a8e7f6d5c4b3a2918
Signature size=9046
Authority=Developer ID Application: LAPLACE Live LLC (9H3CCD4YMM)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 22, 2026 at 3:12:45 AM
Notarization Ticket=stapled
Info.plist entries=32
TeamIdentifier=9H3CCD4YMM
Runtime Version=26.5.0
Sealed Resources version=2 rules=13 files=4379
Internal requirements count=1 size=232
Total signatures=1
Chosen signature=1
`;

/** `codesign -dvvv` of one of the payload's natives, as the same build signed it. */
const NATIVE_SIGNATURE = `Executable=${NATIVE}
Identifier=zvec_node_binding
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=508645 flags=0x10000(runtime) hashes=15889+2 location=embedded
Hash type=sha256 size=32
CandidateCDHash sha256=9d1c6e0b7a2f48c3d5e1b0a9f8c7d6e5a4b3c2d1
CandidateCDHashFull sha256=9d1c6e0b7a2f48c3d5e1b0a9f8c7d6e5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9
Hash choices=sha256
CMSDigest=9d1c6e0b7a2f48c3d5e1b0a9f8c7d6e5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9
CMSDigestType=2
CDHash=9d1c6e0b7a2f48c3d5e1b0a9f8c7d6e5a4b3c2d1
Signature size=9050
Authority=Developer ID Application: LAPLACE Live LLC (9H3CCD4YMM)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 22, 2026 at 3:11:02 AM
Info.plist=not bound
TeamIdentifier=9H3CCD4YMM
Runtime Version=26.5.0
Sealed Resources=none
Internal requirements count=1 size=232
Total signatures=1
Chosen signature=1
`;

/** The same native in an unsigned build, signed ad hoc by -c.mac.identity=-. */
const AD_HOC_NATIVE = `Executable=${NATIVE}
Identifier=zvec_node_binding
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=508629 flags=0x10002(adhoc,runtime) hashes=15889+2 location=embedded
Hash type=sha256 size=32
CandidateCDHash sha256=4e3c7757fdc033761c41d53a59c64ab5db5b3a5f
CandidateCDHashFull sha256=4e3c7757fdc033761c41d53a59c64ab5db5b3a5fcfb9b74875463a71ddd5af41
Hash choices=sha256
CMSDigest=4e3c7757fdc033761c41d53a59c64ab5db5b3a5fcfb9b74875463a71ddd5af41
CMSDigestType=2
CDHash=4e3c7757fdc033761c41d53a59c64ab5db5b3a5f
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Runtime Version=26.5.0
Sealed Resources=none
Internal requirements count=0 size=12
Total signatures=1
Chosen signature=1
`;

describe("macOS", () => {
  test("reads codesign's description of a signature", () => {
    expect(codeSignature(APP_SIGNATURE)).toEqual({
      signed: true,
      flags: 0x10000,
      timestamp: "Nov 22, 2026 at 3:12:45 AM",
      authorities: [
        "Developer ID Application: LAPLACE Live LLC (9H3CCD4YMM)",
        "Developer ID Certification Authority",
        "Apple Root CA",
      ],
      team: "9H3CCD4YMM",
    });
    expect(codeSignature(AD_HOC_NATIVE)).toEqual({
      signed: true,
      flags: 0x10002,
      timestamp: null,
      authorities: [],
      team: null,
    });
    expect(codeSignature(`${NATIVE}: code object is not signed at all\n`)).toMatchObject({
      signed: false,
      timestamp: null,
    });
  });

  test("passes a native with the hardened runtime and a secure timestamp", () => {
    expect(nativeCheck("zvec_node_binding.node", ok(NATIVE_SIGNATURE))).toMatchObject({
      pass: true,
    });
  });

  test("fails the payload natives check when empty or missing the bundled pnpm binary", () => {
    const pnpm = "node-shim/node_modules/node_modules/@pnpm/exe.darwin-arm64/pnpm";
    expect(payloadNativesCheck(["zvec.node", pnpm], [pnpm])).toMatchObject({ pass: true });
    expect(payloadNativesCheck(["zvec.node"], [pnpm])).toMatchObject({
      pass: false,
      detail: `missing: ${pnpm}`,
    });
    expect(payloadNativesCheck([], [])).toMatchObject({ pass: false });
  });

  test("fails a native signed ad hoc, without a secure timestamp, without the runtime or unsigned", () => {
    const failing: [string, ToolRun][] = [
      ["ad hoc", ok(AD_HOC_NATIVE)],
      // Signed with --timestamp=none: codesign gives the signer's own clock instead.
      ["no timestamp", ok(NATIVE_SIGNATURE.replace("Timestamp=", "Signed Time="))],
      ["no runtime", ok(NATIVE_SIGNATURE.replace("flags=0x10000(runtime)", "flags=0x0(none)"))],
      ["unsigned", { status: 1, output: `${NATIVE}: code object is not signed at all\n` }],
    ];
    for (const [why, run] of failing) {
      expect([why, nativeCheck("zvec_node_binding.node", run).pass]).toEqual([why, false]);
    }
    expect(nativeCheck("zvec_node_binding.node", ok(AD_HOC_NATIVE)).detail).toContain(
      "no secure timestamp",
    );
  });

  test("reads an explicit designated requirement, and none from an ad-hoc signature's implicit one", () => {
    // codesign -d -r- prints the requirement on stdout and Executable= on stderr.
    expect(
      designatedRequirement(
        `${ORG_REQUIREMENT}\nExecutable=${APP}/Contents/MacOS/LAPLACE Eidolon\n`,
      ),
    ).toBe(ORG_REQUIREMENT);
    expect(
      designatedRequirement(
        `# designated => cdhash H"ef4e19c118d117d61c414cb1ae3c3ce3b869302b"\nExecutable=${APP}/Contents/MacOS/LAPLACE Eidolon\n`,
      ),
    ).toBeNull();
  });

  test("passes a bundle whose requirement is the file's, and fails the default or an implicit one", () => {
    const helper = "LAPLACE Eidolon Helper (GPU).app";
    expect(requirementCheck(helper, ok(ORG_REQUIREMENT), ORG_REQUIREMENT).pass).toBe(true);
    // What electron-builder writes without mac.requirements: one team, and the bundle's identifier.
    const defaultRequirement =
      'designated => identifier "live.laplace.eidolon.helper.GPU" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "9H3CCD4YMM"';
    const failing = requirementCheck(helper, ok(defaultRequirement), ORG_REQUIREMENT);
    expect(failing.pass).toBe(false);
    expect(failing.detail).toContain('identifier "live.laplace.eidolon.helper.GPU"');
    expect(
      requirementCheck(helper, ok('# designated => cdhash H"ef4e19c1"\n'), ORG_REQUIREMENT).pass,
    ).toBe(false);
  });

  test("takes codesign's deep, strict verification only when it is valid and meets its requirement", () => {
    const passing = `--prepared:${APP}/Contents/Frameworks/LAPLACE Eidolon Helper (GPU).app
--validated:${APP}/Contents/Frameworks/LAPLACE Eidolon Helper (GPU).app
--prepared:${APP}/Contents/Frameworks/Electron Framework.framework/Versions/Current/.
--validated:${APP}/Contents/Frameworks/Electron Framework.framework/Versions/Current/.
${APP}: valid on disk
${APP}: satisfies its Designated Requirement
`;
    expect(verifyCheck(ok(passing)).pass).toBe(true);
    const unsatisfied = {
      status: 3,
      output: `${APP}: valid on disk\n${APP}: does not satisfy its designated Requirement\n`,
    };
    const modified = {
      status: 1,
      output: `${APP}: a sealed resource is missing or invalid\nfile modified: ${APP}/Contents/Resources/eidolon/dist/server.js\n`,
    };
    expect(verifyCheck(unsatisfied).pass).toBe(false);
    expect(verifyCheck(modified)).toMatchObject({ pass: false });
    expect(verifyCheck(modified).detail).toContain("file modified:");
  });

  test("takes Gatekeeper's verdict only for a notarized Developer ID", () => {
    expect(gatekeeperCheck(ok(`${APP}: accepted\nsource=Notarized Developer ID\n`)).pass).toBe(
      true,
    );
    expect(
      gatekeeperCheck(
        ok(
          `${APP}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: LAPLACE Live LLC (9H3CCD4YMM)\n`,
        ),
      ).pass,
    ).toBe(true);
    const unnotarized = {
      status: 3,
      output: `${APP}: rejected\nsource=Unnotarized Developer ID\n`,
    };
    expect(gatekeeperCheck(unnotarized).pass).toBe(false);
    // A system that doesn't require notarization accepts a Developer ID app without it.
    expect(gatekeeperCheck(ok(`${APP}: accepted\nsource=Developer ID\n`)).pass).toBe(false);
    expect(gatekeeperCheck({ status: 3, output: `${APP}: rejected\n` }).pass).toBe(false);
  });

  test("takes the ticket as stapled only when stapler validates it", () => {
    expect(stapleCheck(ok(`Processing: ${APP}\nThe validate action worked!\n`)).pass).toBe(true);
    const missing = {
      status: 65,
      output: `Processing: ${APP}\nLAPLACE Eidolon.app does not have a ticket stapled to it.\n`,
    };
    expect(stapleCheck(missing)).toMatchObject({ pass: false });
    expect(stapleCheck(missing).detail).toContain("does not have a ticket stapled to it");
  });

  test("validates Local Network usage description and unique non-stock Mach-O executable UUIDs", () => {
    const validPlist = {
      NSLocalNetworkUsageDescription:
        "LAPLACE Eidolon uses your local network to connect directly to Subspace servers on your LAN.",
    };
    const uniqueUuids = new Map<string, string | null>([
      ["Contents/MacOS/LAPLACE Eidolon", "11111111-2222-5333-8444-555555555555"],
      [
        "Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
        "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee",
      ],
    ]);
    expect(macBundleLocalNetworkChecks(validPlist, uniqueUuids).every((c) => c.pass)).toBe(true);

    expect(macBundleLocalNetworkChecks({}, uniqueUuids)[0]).toMatchObject({
      name: "Info.plist carries NSLocalNetworkUsageDescription",
      pass: false,
    });

    const stockUuids = new Map<string, string | null>([
      ["Contents/MacOS/LAPLACE Eidolon", "4c4c448e-5555-3144-a14c-bbd02afa9f74"],
      [
        "Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
        "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee",
      ],
    ]);
    expect(macBundleLocalNetworkChecks(validPlist, stockUuids)[1]).toMatchObject({
      name: "app and helper executables carry unique non-stock Mach-O LC_UUIDs",
      pass: false,
    });

    const dupUuids = new Map<string, string | null>([
      ["Contents/MacOS/LAPLACE Eidolon", "11111111-2222-5333-8444-555555555555"],
      [
        "Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
        "11111111-2222-5333-8444-555555555555",
      ],
    ]);
    expect(macBundleLocalNetworkChecks(validPlist, dupUuids)[1]).toMatchObject({
      name: "app and helper executables carry unique non-stock Mach-O LC_UUIDs",
      pass: false,
    });
  });
});

const INSTALL = "C:\\Users\\runneradmin\\AppData\\Local\\Programs\\eidolon";
const SETUP = "D:\\a\\eidolon\\eidolon\\apps\\desktop\\.out\\LAPLACE Eidolon Setup 0.1.0.exe";
const MODULES = `${INSTALL}\\resources\\eidolon\\node_modules`;
const ORT = `${MODULES}\\onnxruntime-node\\bin\\napi-v6\\win32\\x64`;
const ZVEC = `${MODULES}\\@zvec\\bindings-win32-x64`;
const SHARP = `${MODULES}\\@img\\sharp-win32-x64\\lib`;
/** The stage's unsigned-pe.json: Electron's unsigned DLLs and the payload's. */
const LISTED = [
  "LAPLACE Eidolon_wer.dll",
  "dxcompiler.dll",
  "ffmpeg.dll",
  "libvips-42.dll",
  "libvips-cpp-8.18.7.dll",
  "sharp-win32-x64.node",
  "vk_swiftshader.dll",
  "vulkan-1.dll",
  "zvec_node_binding.node",
];
const PUBLISHERS = ["Sparanoid, Inc.", "LAPLACE Live LLC"];
const TIMESTAMPER = "Microsoft Public RSA Time Stamping Authority";
const VC_RUNTIME_SIGNER = "Microsoft Windows Software Compatibility Publisher";

/** One file as the PowerShell pipeline reports it. */
function signature(path: string, signer: string | null, status = "Valid"): Authenticode {
  return {
    Path: path,
    Status: status,
    StatusMessage: status === "Valid" ? "Signature verified." : `${status}.`,
    Signer: signer,
    TimeStamper: signer === null ? null : TIMESTAMPER,
  };
}

/** A signed release's install, its setup included, as Get-AuthenticodeSignature reads it on CI. */
const SIGNED: Authenticode[] = [
  signature(SETUP, "LAPLACE Live LLC"),
  signature(`${INSTALL}\\LAPLACE Eidolon.exe`, "LAPLACE Live LLC"),
  signature(`${INSTALL}\\Uninstall LAPLACE Eidolon.exe`, "LAPLACE Live LLC"),
  signature(`${INSTALL}\\resources\\elevate.exe`, "LAPLACE Live LLC"),
  signature(
    `${INSTALL}\\resources\\eidolon\\node-shim\\node_modules\\node_modules\\@pnpm\\exe.win32-x64\\pnpm.exe`,
    "LAPLACE Live LLC",
  ),
  signature(`${INSTALL}\\d3dcompiler_47.dll`, "Microsoft Windows"),
  ...[
    "dxcompiler.dll",
    "LAPLACE Eidolon_wer.dll",
    "ffmpeg.dll",
    "vk_swiftshader.dll",
    "vulkan-1.dll",
  ].map((name) => signature(`${INSTALL}\\${name}`, "LAPLACE Live LLC")),
  signature(`${ORT}\\onnxruntime_binding.node`, "Microsoft Corporation"),
  signature(`${ORT}\\onnxruntime.dll`, "Microsoft Corporation"),
  ...[
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_atomic_wait.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
  ].map((name) => signature(`${ORT}\\${name}`, VC_RUNTIME_SIGNER)),
  signature(`${ZVEC}\\zvec_node_binding.node`, "LAPLACE Live LLC"),
  ...["sharp-win32-x64.node", "libvips-42.dll", "libvips-cpp-8.18.7.dll"].map((name) =>
    signature(`${SHARP}\\${name}`, "LAPLACE Live LLC"),
  ),
];
const FILES = SIGNED.map((entry) => entry.Path);
const OPTIONS = { root: INSTALL, listed: LISTED, publishers: PUBLISHERS };

/** SIGNED with the entry for the file named `name` replaced. */
function replacing(name: string, entry: (path: string) => Authenticode): Authenticode[] {
  return SIGNED.map((item) => (item.Path.endsWith(`\\${name}`) ? entry(item.Path) : item));
}

function failures(signatures: readonly Authenticode[]): string[] {
  return signatureChecks(FILES, signatures, OPTIONS)
    .filter((check) => !check.pass)
    .map((check) => check.name);
}

describe("Windows", () => {
  test("reads ConvertTo-Json's list, and its bare object for a single file", () => {
    const entry = signature(SETUP, "LAPLACE Live LLC");
    expect(parseAuthenticode(JSON.stringify([entry, entry]))).toEqual([entry, entry]);
    expect(parseAuthenticode(`\uFEFF${JSON.stringify(entry)}\r\n`)).toEqual([entry]);
    expect(
      parseAuthenticode(
        '{"Path":"C:\\\\x\\\\ffmpeg.dll","Status":"NotSigned","StatusMessage":"The file C:\\\\x\\\\ffmpeg.dll is not digitally signed.","Signer":null,"TimeStamper":null}',
      ),
    ).toEqual([
      {
        Path: "C:\\x\\ffmpeg.dll",
        Status: "NotSigned",
        StatusMessage: "The file C:\\x\\ffmpeg.dll is not digitally signed.",
        Signer: null,
        TimeStamper: null,
      },
    ]);
  });

  test("passes a release whose .exe and listed files are the org's and the rest Microsoft's", () => {
    const checks = signatureChecks(FILES, SIGNED, OPTIONS);
    expect(checks).toHaveLength(SIGNED.length);
    expect(checks.filter((check) => !check.pass)).toEqual([]);
    expect(checks.map((check) => check.name)).toContain(
      "resources\\eidolon\\node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\onnxruntime.dll keeps Microsoft's signature",
    );
    expect(checks.map((check) => check.name)).toContain(
      "LAPLACE Eidolon Setup 0.1.0.exe is signed by the org",
    );
  });

  test("fails a listed file left unsigned, or one whose signature no longer matches its bytes", () => {
    expect(failures(replacing("ffmpeg.dll", (path) => signature(path, null, "NotSigned")))).toEqual(
      ["ffmpeg.dll is signed by the org"],
    );
    expect(
      failures(
        replacing("zvec_node_binding.node", (path) =>
          signature(path, "LAPLACE Live LLC", "HashMismatch"),
        ),
      ),
    ).toEqual([
      "resources\\eidolon\\node_modules\\@zvec\\bindings-win32-x64\\zvec_node_binding.node is signed by the org",
    ]);
  });

  test("fails Microsoft's file once the release re-signed it, and an .exe someone else signed", () => {
    expect(
      failures(replacing("d3dcompiler_47.dll", (path) => signature(path, "LAPLACE Live LLC"))),
    ).toEqual(["d3dcompiler_47.dll keeps Microsoft's signature"]);
    expect(
      failures(
        replacing("LAPLACE Eidolon Setup 0.1.0.exe", (path) => signature(path, "Someone Else")),
      ),
    ).toEqual(["LAPLACE Eidolon Setup 0.1.0.exe is signed by the org"]);
  });

  // Trusted Signing's certificates last three days: a signature without a timestamp lapses with one.
  test("fails a valid signature without a timestamp, the org's or Microsoft's", () => {
    const unstamped = (path: string, signer: string): Authenticode => ({
      ...signature(path, signer),
      TimeStamper: null,
    });
    const org = replacing("ffmpeg.dll", (path) => unstamped(path, "LAPLACE Live LLC"));
    expect(
      signatureChecks(FILES, org, OPTIONS)
        .filter((check) => !check.pass)
        .map((check) => [check.name, check.detail]),
    ).toEqual([["ffmpeg.dll is signed by the org", "Valid, LAPLACE Live LLC, not timestamped"]]);
    expect(
      failures(replacing("d3dcompiler_47.dll", (path) => unstamped(path, "Microsoft Windows"))),
    ).toEqual(["d3dcompiler_47.dll keeps Microsoft's signature"]);
  });

  // signExts matches the end of a path, so a listed name that ends another file's name signs both.
  test("fails a Microsoft file whose name ends with a listed one, which the release signed too", () => {
    const listed = [...LISTED, "140.dll"];
    const overSigned = SIGNED.map((item) =>
      item.Path.endsWith("\\msvcp140.dll") ? signature(item.Path, "LAPLACE Live LLC") : item,
    );
    expect(
      signatureChecks(FILES, overSigned, { ...OPTIONS, listed })
        .filter((check) => !check.pass)
        .map((check) => check.name),
    ).toEqual([
      "resources\\eidolon\\node_modules\\onnxruntime-node\\bin\\napi-v6\\win32\\x64\\msvcp140.dll keeps Microsoft's signature",
    ]);
  });

  test("reads the listed paths' signatures, quoting the list's path for PowerShell", () => {
    const script = authenticodeScript("C:\\Users\\o'brien\\files.txt");
    expect(script).toContain(
      "Get-Content -LiteralPath 'C:\\Users\\o''brien\\files.txt' -Encoding UTF8",
    );
    expect(script).toContain("Get-AuthenticodeSignature -LiteralPath $_");
  });

  test("fails a file it found but has no signature for", () => {
    const read = SIGNED.filter((item) => !item.Path.endsWith("\\vulkan-1.dll"));
    const failed = signatureChecks(FILES, read, OPTIONS).filter((check) => !check.pass);
    expect(failed.map((check) => [check.name, check.detail])).toEqual([
      ["vulkan-1.dll is signed by the org", "Get-AuthenticodeSignature reported nothing for it"],
    ]);
  });

  test("needs the install to hold the app, its uninstaller, each listed file and Microsoft's", () => {
    const required = requiredInInstall(LISTED);
    expect(required).toEqual(
      expect.arrayContaining([
        "LAPLACE Eidolon.exe",
        "Uninstall LAPLACE Eidolon.exe",
        "pnpm.exe",
        "d3dcompiler_47.dll",
        "onnxruntime.dll",
        "onnxruntime_binding.node",
        "vcruntime140.dll",
        "msvcp140_atomic_wait.dll",
        ...LISTED,
      ]),
    );
    expect(presenceCheck(FILES, required).pass).toBe(true);
    const withoutUninstaller = FILES.filter(
      (path) => !path.endsWith("\\Uninstall LAPLACE Eidolon.exe"),
    );
    expect(presenceCheck(withoutUninstaller, required)).toMatchObject({
      pass: false,
      detail: "missing: Uninstall LAPLACE Eidolon.exe",
    });
  });

  test("refuses to run when the per-user install folder already exists, even with an older executable", () => {
    const present = new Set([INSTALL, `${INSTALL}\\Eidolon.exe`]);
    expect(() => ensureNoWindowsInstall(INSTALL, (path) => present.has(path))).toThrow(
      `LAPLACE Eidolon is already installed for this user in ${INSTALL}`,
    );
    expect(() => ensureNoWindowsInstall(INSTALL, () => false)).not.toThrow();
  });
});

describe("macOS anti-doxxing checks", () => {
  const ORG_PROFILE = {
    TeamIdentifier: ["9H3CCD4YMM"],
    TeamName: "LAPLACE Live LLC",
    DeveloperCertificates: ["ZmFrZS1jZXJ0"],
    Entitlements: {
      "com.apple.application-identifier": "9H3CCD4YMM.live.laplace.eidolon",
      "com.apple.developer.usernotifications.communication": true,
    },
  };
  const ORG_CERT = ok(
    "subject=UID=dev,CN=Developer ID Application: LAPLACE Live LLC (9H3CCD4YMM),OU=9H3CCD4YMM,O=LAPLACE Live LLC,C=US\n",
  );
  const SPARANID_CERT = ok(
    "subject=CN=Developer ID Application: Sparanoid\\, Inc. (B5483RCL5H),OU=B5483RCL5H,O=Sparanoid\\, Inc.,C=US\n",
  );

  test("accepts allowed organization Developer ID app signatures and rejects personal signers", () => {
    expect(macSignerCheck(ok(APP_SIGNATURE)).pass).toBe(true);
    const personalTeam = APP_SIGNATURE.replaceAll("9H3CCD4YMM", "PERS123456").replaceAll(
      "LAPLACE Live LLC",
      "Jane Doe",
    );
    expect(macSignerCheck(ok(personalTeam)).pass).toBe(false);
    const personalNameSameTeam = APP_SIGNATURE.replace(
      "Authority=Developer ID Application: LAPLACE Live LLC (9H3CCD4YMM)",
      "Authority=Developer ID Application: Jane Doe (9H3CCD4YMM)",
    );
    expect(macSignerCheck(ok(personalNameSameTeam)).pass).toBe(false);
  });

  test("accepts an organization provisioning profile with communication notifications", () => {
    const checks = provisioningProfileChecks(ORG_PROFILE, [ORG_CERT]);
    expect(checks.every((check) => check.pass)).toBe(true);

    const sparanoidChecks = provisioningProfileChecks(
      {
        ...ORG_PROFILE,
        TeamIdentifier: ["B5483RCL5H"],
        TeamName: "Sparanoid, Inc.",
        Entitlements: {
          "com.apple.application-identifier": "B5483RCL5H.live.laplace.eidolon",
          "com.apple.developer.usernotifications.communication": true,
        },
      },
      [SPARANID_CERT],
    );
    expect(sparanoidChecks.every((check) => check.pass)).toBe(true);
  });

  test("rejects personal team names, ProvisionedDevices UDIDs, emails, personal certs, and missing entitlements", () => {
    const failedNames = (profile: unknown, certs: readonly ToolRun[]) =>
      provisioningProfileChecks(profile, certs)
        .filter((check) => !check.pass)
        .map((check) => check.name);

    expect(failedNames({ ...ORG_PROFILE, TeamName: "Jane Doe" }, [ORG_CERT])).toContain(
      "embedded.provisionprofile belongs to an allowed organization team",
    );

    expect(
      failedNames({ ...ORG_PROFILE, ProvisionedDevices: ["00008112-001234567890001E"] }, [
        ORG_CERT,
      ]),
    ).toContain("embedded.provisionprofile has no provisioned device UDIDs or email addresses");

    expect(
      failedNames({ ...ORG_PROFILE, Name: "profile for jane@example.com" }, [ORG_CERT]),
    ).toContain("embedded.provisionprofile has no provisioned device UDIDs or email addresses");

    expect(
      failedNames(ORG_PROFILE, [
        ok("subject=CN=Apple Development: Jane Doe (9H3CCD4YMM),OU=9H3CCD4YMM,O=Jane Doe,C=US\n"),
      ]),
    ).toContain("embedded.provisionprofile holds only organization Developer ID certificates");

    expect(
      failedNames(ORG_PROFILE, [
        ok(
          "subject=CN=Developer ID Application: LAPLACE Live LLC (9H3CCD4YMM),OU=9H3CCD4YMM,O=LAPLACE Live LLC,C=US\njane@example.com\n",
        ),
      ]),
    ).toContain("embedded.provisionprofile holds only organization Developer ID certificates");

    expect(
      failedNames(
        {
          ...ORG_PROFILE,
          Entitlements: {
            "com.apple.application-identifier": "9H3CCD4YMM.live.laplace.eidolon",
          },
        },
        [ORG_CERT],
      ),
    ).toContain(
      "embedded.provisionprofile grants communication notifications for live.laplace.eidolon",
    );
  });

  test("parses real Apple XML1 plists containing date and base64 data nodes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AppIDName</key>
  <string>LAPLACE &amp; Eidolon</string>
  <key>CreationDate</key>
  <date>2026-11-26T19:26:12Z</date>
  <key>IsXcodeManaged</key>
  <false/>
  <key>ProvisionsAllDevices</key>
  <true/>
  <key>TimeToLive</key>
  <integer>6570</integer>
  <key>DeveloperCertificates</key>
  <array>
    <data>
    ZmFr
    ZS1jZXJ0
    </data>
  </array>
  <key>DER-Encoded-Profile</key>
  <data>YWJjQGV4YW1wbGUuY29t</data>
  <key>Entitlements</key>
  <dict>
    <key>com.apple.application-identifier</key>
    <string>9H3CCD4YMM.live.laplace.eidolon</string>
    <key>com.apple.developer.usernotifications.communication</key>
    <true/>
  </dict>
  <key>TeamIdentifier</key>
  <array>
    <string>9H3CCD4YMM</string>
  </array>
  <key>TeamName</key>
  <string>LAPLACE Live LLC</string>
  <key>EmptyNote</key>
  <string/>
</dict>
</plist>`;
    const parsed = parseAppleXmlPlist(xml) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      AppIDName: "LAPLACE & Eidolon",
      CreationDate: "2026-11-26T19:26:12Z",
      IsXcodeManaged: false,
      ProvisionsAllDevices: true,
      TimeToLive: 6570,
      DeveloperCertificates: ["ZmFrZS1jZXJ0"],
      TeamIdentifier: ["9H3CCD4YMM"],
      TeamName: "LAPLACE Live LLC",
      EmptyNote: "",
    });
    const realCert = ok(
      "subject=C=US,O=LAPLACE Live LLC,OU=9H3CCD4YMM,CN=Developer ID Application: LAPLACE Live LLC (9H3CCD4YMM),UID=9H3CCD4YMM\n",
    );
    expect(provisioningProfileChecks(parsed, [realCert]).every((c) => c.pass)).toBe(true);
  });

  test("parses self-closing Apple XML1 plist tags with whitespace before />", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Enabled</key><true />
  <key>Disabled</key><false />
  <key>Empty</key><string />
  <key>NestedDict</key><dict />
  <key>NestedArray</key><array />
</dict>
</plist>`;
    expect(parseAppleXmlPlist(xml)).toEqual({
      Enabled: true,
      Disabled: false,
      Empty: "",
      NestedDict: {},
      NestedArray: [],
    });
  });
});
