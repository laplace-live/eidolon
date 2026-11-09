// python-dotenv's parser: `export` prefixes, single-quoted keys, quoted values that may span lines
// (double quotes decode only \\ \' \" \a \b \f \n \r \t \v), ` #` comments, and `${VAR}` /
// `${VAR:-default}` interpolation in every value, single-quoted ones included. A quoted value
// followed by anything but a comment drops the whole line, as python-dotenv's "could not parse
// statement" does.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface DotenvEntry {
  key: string;
  value: string;
}

const ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?(?:'([^']+)'|([^=#\s]+))[ \t]*=[ \t]*/;
const AFTER_QUOTE = /^[^\S\r\n]*(?:#[^\r\n]*)?\r?$/;
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

function decodeDoubleQuoted(raw: string): string {
  return raw.replace(
    /\\([\\'"abfnrtv])/g,
    (_match, esc: string) => DOUBLE_QUOTE_ESCAPES[esc] ?? "",
  );
}

function decodeSingleQuoted(raw: string): string {
  return raw.replace(/\\([\\'])/g, "$1");
}

function closingQuote(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

export function parseDotenv(text: string): DotenvEntry[] {
  const entries: DotenvEntry[] = [];
  let pos = 0;
  while (pos < text.length) {
    const lineEnd = text.indexOf("\n", pos);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(pos, end);
    const match = ASSIGNMENT.exec(line);
    if (!match || line.trimStart().startsWith("#")) {
      pos = end + 1;
      continue;
    }
    const key = (match[1] ?? match[2]) as string;
    const valueStart = pos + match[0].length;
    const quote = text[valueStart];
    if (quote === '"' || quote === "'") {
      const close = closingQuote(text, valueStart + 1, quote);
      if (close === -1) {
        pos = end + 1;
        continue;
      }
      const raw = text.slice(valueStart + 1, close);
      const after = text.indexOf("\n", close);
      const lineRest = text.slice(close + 1, after === -1 ? text.length : after);
      if (AFTER_QUOTE.test(lineRest)) {
        entries.push({
          key,
          value: quote === '"' ? decodeDoubleQuoted(raw) : decodeSingleQuoted(raw),
        });
      }
      pos = after === -1 ? text.length : after + 1;
      continue;
    }
    const raw = text.slice(valueStart, end).replace(/\r$/, "");
    entries.push({ key, value: raw.replace(/\s+#.*/, "").trimEnd() });
    pos = end + 1;
  }
  return entries;
}

function interpolate(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([^}:]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    return env[name] ?? fallback ?? "";
  });
}

/**
 * The nearest `.env` at or above `startDir`, as python-dotenv's `find_dotenv` walks. A linked git
 * worktree without one of its own reads its main checkout's, wherever the worktree lives.
 */
export function findDotenv(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const inherited = mainCheckoutDotenv(join(dir, ".git"));
    if (inherited !== null) return inherited;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A linked worktree's `.git` is a file, `gitdir: <main>/.git/worktrees/<name>`, and that folder's
 * `commondir` leads back to `<main>/.git`. Submodules have the file but no `commondir`.
 */
function mainCheckoutDotenv(dotGit: string): string | null {
  if (!statSync(dotGit, { throwIfNoEntry: false })?.isFile()) return null;
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
  if (gitdir === undefined) return null;
  const linked = resolve(dirname(dotGit), gitdir);
  const commondir = join(linked, "commondir");
  if (!existsSync(commondir)) return null;
  const common = resolve(linked, readFileSync(commondir, "utf8").trim());
  if (basename(common) !== ".git") return null;
  const candidate = join(dirname(common), ".env");
  return existsSync(candidate) ? candidate : null;
}

/**
 * Apply a .env file to `process.env`. With `override` (the bot's mode, as `load_dotenv(override=True)`),
 * file values win over the inherited environment.
 */
export function loadDotenv(path: string | null, options: { override?: boolean } = {}): string[] {
  if (!path || !existsSync(path)) return [];
  const override = options.override ?? true;
  const resolved: Record<string, string> = {};
  for (const entry of parseDotenv(readFileSync(path, "utf8"))) {
    const env = override ? { ...process.env, ...resolved } : { ...resolved, ...process.env };
    resolved[entry.key] = interpolate(entry.value, env);
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(resolved)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
