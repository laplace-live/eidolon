// Windows: whether a downloaded update's setup is signed by a name its install accepts. It replaces
// electron-updater's own check, which takes a PowerShell that fails or times out (20 s, then a 10 s
// probe) for an old one and installs the setup unchecked
// (electron-updater/out/windowsExecutableCodeSignatureVerifier.js handleError): on a CI runner its
// cold start took that long. This one waits longer, and a check that can't run refuses the update.
// Electron-free: updater.ts runs the script.

/** How long PowerShell may take, its cold start under an antivirus scan included. */
export const SIGNATURE_TIMEOUT_MS = 120_000;

/** The PowerShell script that reports `file`'s Authenticode status, path and signer, as JSON. */
export function signatureScript(file: string): string {
  const literal = file.replace(/'/g, "''");
  return [
    '$ProgressPreference = "SilentlyContinue"',
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'`,
    "[pscustomobject]@{ Status = [string]$s.Status; Path = [string]$s.Path; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress",
  ].join("\n");
}

/** powershell.exe's arguments for `script`, encoded so no quoting reaches a shell. */
export function powershellArgs(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

/**
 * A distinguished name's attributes, such as `CN="Sparanoid, Inc.", O=…`: split at commas outside
 * quotes, a quoted value unquoted and its doubled quotes made one.
 */
export function parseDn(dn: string): Map<string, string> {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < dn.length; i++) {
    const char = dn[i] as string;
    if (char === '"') {
      if (quoted && dn[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  const attributes = new Map<string, string>();
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at > 0) attributes.set(part.slice(0, at).trim().toUpperCase(), part.slice(at + 1).trim());
  }
  return attributes;
}

/** Windows' path compare: separators and case aside. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string) => path.replaceAll("/", "\\").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Null when the script's output says `file` is validly signed by one of `publisherNames`, matched
 * by its signer's CN; else why not, which electron-updater reports as the download's failure.
 */
export function signatureVerdict(
  stdout: string,
  file: string,
  publisherNames: readonly string[],
): string | null {
  let report: { Status?: unknown; Path?: unknown; Subject?: unknown };
  try {
    report = JSON.parse(stdout);
  } catch {
    return `the update's signature check printed no report: ${stdout.trim().slice(0, 200)}`;
  }
  if (report.Status !== "Valid") return `the update's signature is ${String(report.Status)}`;
  if (typeof report.Path !== "string" || !samePath(report.Path, file)) {
    return `the signature check read ${String(report.Path)}, not ${file}`;
  }
  const signer = parseDn(typeof report.Subject === "string" ? report.Subject : "").get("CN");
  if (signer === undefined || !publisherNames.includes(signer)) {
    return `the update is signed by ${signer ?? "no one"}, not ${publisherNames.join(" or ")}`;
  }
  return null;
}
