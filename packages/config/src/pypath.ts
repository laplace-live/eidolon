// pathlib's PurePosixPath reading of a path string: Python parses paths this way before taking
// their name, stem or suffix, and prints them in this form. On Windows a backslash separates too
// and a drive's root is a root, and a path prints with forward slashes, which Windows reads alike.
import { pyStrRepr } from "./py.ts";

/** `path`'s root ("/", "//", or on Windows a drive's, "C:/"), and its other parts. */
function split(path: string): [root: string, parts: string[]] {
  const windows = process.platform === "win32";
  const rest = windows ? path.replaceAll("\\", "/") : path;
  const drive = windows ? (/^[A-Za-z]:\//.exec(rest)?.[0] ?? "") : "";
  // POSIX leaves exactly two leading slashes implementation-defined, so pathlib keeps them.
  const root =
    drive ||
    (rest.startsWith("//") && !rest.startsWith("///") ? "//" : rest.startsWith("/") ? "/" : "");
  const parts = rest
    .slice(root.length)
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  return [root, parts];
}

/** `str(PurePosixPath(path))`: repeated and trailing slashes collapse, `.` segments drop. */
export function pyPath(path: string): string {
  const [root, parts] = split(path);
  return root + parts.join("/") || ".";
}

/** `PurePosixPath(path).name`. */
export function pyPathName(path: string): string {
  return split(path)[1].at(-1) ?? "";
}

function suffixAt(name: string): number {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? i : -1;
}

/** `PurePosixPath(path).stem`: the name minus its last suffix; `.png` and `a.` have none. */
export function pyPathStem(path: string): string {
  const name = pyPathName(path);
  const i = suffixAt(name);
  return i === -1 ? name : name.slice(0, i);
}

/** `PurePosixPath(path).suffix`. */
export function pyPathSuffix(path: string): string {
  const name = pyPathName(path);
  const i = suffixAt(name);
  return i === -1 ? "" : name.slice(i);
}

/** `PurePosixPath(path).parent`. */
export function pyPathParent(path: string): string {
  const [root, parts] = split(path);
  return parts.length <= 1 ? root || "." : root + parts.slice(0, -1).join("/");
}

/** `PurePosixPath(path).relative_to(base)`, for a path inside `base`. */
export function pyPathRelativeTo(path: string, base: string): string {
  const normalized = pyPath(path);
  const root = pyPath(base);
  if (root === ".") return normalized;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`${pyStrRepr(normalized)} is not in the subpath of ${pyStrRepr(root)}`);
  }
  return normalized.slice(prefix.length);
}

/** `PurePosixPath(path).with_name(name)`, normalized like `pyPath`. */
export function pyPathWithName(path: string, name: string): string {
  const normalized = pyPath(path);
  const current = pyPathName(normalized);
  if (!current) throw new Error(`${normalized} has an empty name`);
  return normalized.slice(0, normalized.length - current.length) + name;
}

/** `PurePosixPath(path).with_suffix(suffix)`, normalized like `pyPath`. */
export function pyPathWithSuffix(path: string, suffix: string): string {
  const stem = pyPathStem(path);
  if (!stem) throw new Error(`${pyPath(path)} has an empty name`);
  if (suffix === "." || (suffix && !suffix.startsWith("."))) {
    throw new Error(`Invalid suffix ${pyStrRepr(suffix)}`);
  }
  return pyPathWithName(path, stem + suffix);
}
