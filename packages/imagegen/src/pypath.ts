// pathlib's PurePosixPath reading of a path string. Python parses every reference path, URL and
// selfie id this way before taking its name, stem or suffix, and prints paths in this form.

function parts(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

/** `str(PurePosixPath(path))`: repeated and trailing slashes collapse, `.` segments drop. */
export function pyPath(path: string): string {
  // POSIX leaves exactly two leading slashes implementation-defined, so pathlib keeps them.
  const root =
    path.startsWith("//") && !path.startsWith("///") ? "//" : path.startsWith("/") ? "/" : "";
  return root + parts(path).join("/") || ".";
}

/** `PurePosixPath(path).name`. */
export function pyPathName(path: string): string {
  return parts(path).at(-1) ?? "";
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

/** `PurePosixPath(path).with_name(name)`, normalized like `pyPath`. */
export function pyPathWithName(path: string, name: string): string {
  const normalized = pyPath(path);
  const current = pyPathName(normalized);
  if (!current) throw new Error(`${normalized} has an empty name`);
  return normalized.slice(0, normalized.length - current.length) + name;
}
