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

/**
 * The executable file `name` names: a name with a slash as given, else the first match in `path`'s
 * folders (empty entries skipped). Null when there is none.
 */
export function which(name: string, path: string = process.env.PATH ?? ""): string | null {
  if (name === "") return null;
  if (name.includes("/")) {
    const file = resolve(name);
    return isExecutableFile(file) ? file : null;
  }
  for (const folder of path.split(delimiter)) {
    if (folder === "") continue;
    const file = resolve(folder, name);
    if (isExecutableFile(file)) return file;
  }
  return null;
}
