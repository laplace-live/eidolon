import { describe, expect, test } from "vitest";
import {
  parseDn,
  powershellArgs,
  powershellExe,
  signatureScript,
  signatureVerdict,
} from "../src/main/update-signature.ts";

const FILE =
  "C:\\Users\\me\\AppData\\Local\\eidolon-updater\\pending\\temp-LAPLACE Eidolon Setup 0.0.2.exe";
const NAMES = ["Sparanoid, Inc.", "LAPLACE Live LLC"];
const LAPLACE = "CN=LAPLACE Live LLC, O=LAPLACE Live LLC, L=Wilmington, S=Delaware, C=US";

const report = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ Status: "Valid", Path: FILE, Subject: LAPLACE, ...over });

describe("signatureVerdict", () => {
  test("passes a valid signature by a listed name, the path compared as Windows does", () => {
    expect(signatureVerdict(report(), FILE, NAMES)).toBeNull();
    expect(signatureVerdict(report({ Path: FILE.toLowerCase() }), FILE, NAMES)).toBeNull();
  });

  test("reads a quoted CN with a comma in it", () => {
    const subject = 'CN="Sparanoid, Inc.", O="Sparanoid, Inc.", C=US';
    expect(signatureVerdict(report({ Subject: subject }), FILE, NAMES)).toBeNull();
  });

  test("refuses a signature that isn't valid, a name not listed, another file or no signer", () => {
    expect(signatureVerdict(report({ Status: "NotSigned" }), FILE, NAMES)).toBe(
      "the update's signature is NotSigned",
    );
    expect(signatureVerdict(report({ Status: "HashMismatch" }), FILE, NAMES)).toMatch(
      /HashMismatch/,
    );
    expect(signatureVerdict(report({ Subject: "CN=Someone Else, C=US" }), FILE, NAMES)).toBe(
      "the update is signed by Someone Else, not Sparanoid, Inc. or LAPLACE Live LLC",
    );
    // A listed name in another attribute is no signer.
    expect(
      signatureVerdict(report({ Subject: "CN=Evil, O=LAPLACE Live LLC" }), FILE, NAMES),
    ).toMatch(/signed by Evil/);
    expect(signatureVerdict(report({ Path: "C:\\other.exe" }), FILE, NAMES)).toMatch(/not C:/);
    expect(signatureVerdict(report({ Subject: "" }), FILE, NAMES)).toMatch(/signed by no one/);
  });

  test("refuses when PowerShell printed no report", () => {
    expect(signatureVerdict("", FILE, NAMES)).toMatch(/printed no report/);
    expect(signatureVerdict("Get-AuthenticodeSignature : denied", FILE, NAMES)).toMatch(
      /printed no report: Get-AuthenticodeSignature : denied/,
    );
  });
});

describe("parseDn", () => {
  test("splits at commas outside quotes and unquotes values", () => {
    expect(parseDn('CN="A, ""B""", O=C')).toEqual(
      new Map([
        ["CN", 'A, "B"'],
        ["O", "C"],
      ]),
    );
  });
});

describe("the script", () => {
  test("quotes the path for PowerShell and encodes the script as UTF-16", () => {
    const script = signatureScript("C:\\it's here\\setup.exe");
    expect(script).toContain("-LiteralPath 'C:\\it''s here\\setup.exe'");
    const args = powershellArgs(script);
    expect(args.slice(0, 5)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    expect(Buffer.from(args[5] as string, "base64").toString("utf16le")).toBe(script);
  });

  test("names Windows PowerShell by its full path under SystemRoot, never by its bare name", () => {
    const exe = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(powershellExe({ SystemRoot: "D:\\WINNT" })).toBe(`D:\\WINNT\\${exe}`);
    for (const env of [{}, { SystemRoot: "" }]) {
      expect(powershellExe(env)).toBe(`C:\\Windows\\${exe}`);
    }
  });
});
