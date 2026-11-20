import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `name` as Windows runs it: as written when it ends in one of PATHEXT's, else with each of them. */
function windowsNames(name: string): string[] {
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension !== "")
    .map((extension) => extension.toLowerCase());
  const lower = name.toLowerCase();
  if (extensions.some((extension) => lower.endsWith(extension))) return [name];
  return extensions.map((extension) => `${name}${extension}`);
}

/**
 * The executable file `name` names: a name with a slash (or, on Windows, a backslash) as given,
 * else the first match in `path`'s folders (empty entries skipped). On Windows a name without one
 * of PATHEXT's extensions matches with each of them, as cmd.exe runs it. Null when there is none.
 */
export function which(
  name: string,
  path: string = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (name === "") return null;
  const windows = platform === "win32";
  const names = windows ? windowsNames(name) : [name];
  if (name.includes("/") || (windows && name.includes("\\"))) {
    return names.map((each) => resolve(each)).find(isExecutableFile) ?? null;
  }
  for (const folder of path.split(delimiter)) {
    if (folder === "") continue;
    for (const each of names) {
      const file = resolve(folder, each);
      if (isExecutableFile(file)) return file;
    }
  }
  return null;
}
