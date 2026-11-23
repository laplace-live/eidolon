// npx for an MCP server where the computer has none, deciding as npm's npx does: a bin of the
// project's own or in a node_modules/.bin from npm's local prefix up, or a package the project has
// installed, runs as it is; anything else the pnpm Eidolon bundles installs into its dlx cache, set
// to install as npm does. The command then runs here, on npm's PATH and in npm's folder, and npx
// ends as it did. pnpm reports on stderr, so the server's stdout, which the MCP protocol owns,
// holds only what the server prints.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  globSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cmdLine } from "./cross-spawn.mjs";

const DROPPED = new Set(["-y", "--yes", "-q", "--quiet"]);

/** `text` with each ${VAR} npm's config expands from `env`: none when unset, `${VAR?}` empty. */
export function envReplace(text, env) {
  return text.replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g, (whole, escapes, name, optional) => {
    // An odd run of backslashes escapes the ${, and each pair before it is one backslash.
    if (escapes.length % 2 === 1) return whole.slice((escapes.length + 1) / 2);
    const value = env[name] ?? (optional === "?" ? "" : `\${${name}}`);
    return escapes.slice(escapes.length / 2) + value;
  });
}

/** A key or value of an .npmrc line as npm's ini parser reads it: quoted, it is JSON's. */
function iniWord(raw) {
  const word = raw.trim();
  const quote = word[0];
  if ((quote === '"' || quote === "'") && word.endsWith(quote)) {
    const inner = word.startsWith("'") ? word.slice(1, -1) : word;
    try {
      return JSON.parse(inner);
    } catch {
      return inner;
    }
  }
  // Unquoted, it ends at a ; or # comment, and \; \# \\ stand for the character.
  let out = "";
  for (let at = 0; at < word.length; at++) {
    const char = word[at];
    if (char === ";" || char === "#") break;
    if (char !== "\\") out += char;
    else if (at + 1 === word.length) out += "\\";
    else out += "\\;#".includes(word[at + 1]) ? word[++at] : `\\${word[++at]}`;
  }
  return out.trim();
}

/** The settings an .npmrc gives before any [section], decoded as npm's ini parser does. */
function iniDecode(text) {
  const settings = {};
  for (const line of text.split(/[\r\n]+/)) {
    if (/^\s*(?:[;#]|$)/.test(line)) continue;
    const match = /^\[[^\]]*\]\s*$|^([^=]+)(=(.*))?$/.exec(line);
    if (match === null) continue;
    if (match[1] === undefined) break;
    const raw = String(iniWord(match[1]));
    const list = raw.length > 2 && raw.endsWith("[]");
    const key = list ? raw.slice(0, -2) : raw;
    if (key === "__proto__") continue;
    const word = match[2] ? iniWord(match[3]) : true;
    const value = word === "true" || word === "false" || word === "null" ? JSON.parse(word) : word;
    if (list && !Object.hasOwn(settings, key)) settings[key] = [];
    else if (list && !Array.isArray(settings[key])) settings[key] = [settings[key]];
    if (Array.isArray(settings[key])) settings[key].push(value);
    else settings[key] = value;
  }
  return settings;
}

/**
 * The settings an .npmrc gives before any [section], as npm reads them: `key[]` lines as a list,
 * and each ${VAR} in a key or value expanded from `env`.
 */
function readNpmrc(file, env) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  // npm expands the keys of the file as decoded, so of two that expand alike, the one the file
  // first names later wins.
  const asRead = (value) =>
    typeof value === "string" ? envReplace(value.trim(), env) : JSON.stringify(value);
  const settings = {};
  for (const [raw, value] of Object.entries(iniDecode(text))) {
    const key = envReplace(raw, env);
    if (key !== "__proto__") {
      settings[key] = Array.isArray(value) ? value.map(asRead) : asRead(value);
    }
  }
  return settings;
}

/**
 * npm's config sources npx reads, highest first, each as `{ key: value }`: the npm_config_*
 * variables in `env`, the .npmrc at npm's local `prefix`, then the user's, ${VAR} expanded as npm
 * expands them.
 */
export function npmConfig(env, prefix, home) {
  const variables = {};
  for (const [name, value] of Object.entries(env)) {
    const key = /^npm_config_(.+)$/i.exec(name)?.[1];
    if (key === undefined || !value) continue;
    const setting = envReplace(
      key.startsWith("//") ? key : key.replace(/(?!^)_/g, "-").toLowerCase(),
      env,
    );
    if (setting !== "__proto__") variables[setting] = envReplace(value.trim(), env);
  }
  const user = path.resolve(variables.userconfig ?? path.join(home, ".npmrc"));
  const project = path.join(prefix, ".npmrc");
  return [variables, project === user ? {} : readNpmrc(project, env), readNpmrc(user, env)];
}

/** A setting from the highest of npm's config `sources` that gives it. */
const settingOf = (sources, key) => sources.find((source) => Object.hasOwn(source, key))?.[key];

// The settings of npm's project config that pnpm reads from an .npmrc and npm installs by: the
// registries, their credentials (npm's nerf-darted keys) and certificates.
const NERF_DARTS = ["_auth", "_authToken", "_password", "certfile", "email", "keyfile", "username"];
const REGISTRY_SETTING = new RegExp(
  `^(?:registry|ca|cafile|cert|key|@[^:/]+:registry|//.*:(?:${NERF_DARTS.join("|")}))$`,
);

/**
 * An .npmrc for pnpm holding the registries, credentials and certificates of npm's `project`
 * config as npm reads them, each file they name as npm finds it from `cwd`; empty with none.
 */
export function projectNpmrc(project, cwd, home, platform = process.platform) {
  const lines = [];
  // npm takes a ${VAR} it left, VAR being unset, as written. pnpm ignores a registry or
  // credential holding one in a project's .npmrc, so the user's would serve in its place, and
  // expands any other again: percent-encoded, it reaches pnpm as npm has it, an invalid URL or a
  // wrong token. A key holding one names no registry. npm takes an empty value as none. Of these
  // settings only ca is a list.
  const placeholder = /\$\{[^}]+\}/;
  const asWritten = (text) =>
    placeholder.test(text) ? text.replace(/[${}]/g, (char) => encodeURIComponent(char)) : text;
  for (const [key, value] of Object.entries(project)) {
    if (!REGISTRY_SETTING.test(key) || /[=\r\n]/.test(key) || placeholder.test(key)) continue;
    if (Array.isArray(value) && key !== "ca") continue;
    const client = /^(.*):(?:certfile|keyfile)$/.exec(key)?.[1];
    // npm presents a client certificate only with both files there; pnpm ends on a missing one.
    const pair = [project[`${client}:certfile`], project[`${client}:keyfile`]];
    const there = (file) =>
      typeof file === "string" &&
      file !== "" &&
      stat(path.resolve(cwd, asWritten(file))) !== undefined;
    if (client !== undefined && !pair.every(there)) continue;
    for (const text of [value]
      .flat()
      .filter((text) => text !== "")
      .map(asWritten)) {
      let file = text;
      if (key === "cafile") {
        const fromHome = (platform === "win32" ? /^~[/\\]/ : /^~\//).test(text);
        file = fromHome ? path.resolve(home, text.slice(2)) : path.resolve(cwd, text);
      } else if (client !== undefined) {
        file = path.resolve(cwd, text);
      }
      // Quoted, pnpm's ini parser reads each back as it is.
      lines.push(
        `${JSON.stringify(Array.isArray(value) ? `${key}[]` : key)}=${JSON.stringify(file)}`,
      );
    }
  }
  return lines.join("\n");
}

/** A boolean setting as npm reads one: a number unless 0, any other word unless false or null. */
function flag(value) {
  if (value === undefined) return false;
  const number = Number(value);
  return Number.isNaN(number) ? value !== "false" && value !== "null" : number !== 0;
}

/**
 * The minutes npm's `before` or `min-release-age` holds a version back, from the highest source
 * that gives either, `before` first within one.
 */
function releaseAge(sources, now) {
  for (const source of sources) {
    const before = Date.parse(source.before ?? "");
    if (!Number.isNaN(before)) return Math.max(0, Math.ceil((now - before) / 60_000));
    const days = Number(source["min-release-age"] ?? Number.NaN);
    if (!Number.isNaN(days)) return Math.max(0, Math.ceil(days * 1440));
  }
  return 0;
}

/**
 * pnpm's settings that make its dlx install what npm's npx would, as npx would, under npm's config
 * `sources` as npmConfig reads them, its variables first; or why it can't.
 * @returns {string[] | { error: string }}
 */
export function npxSettings(sources, now = Date.now()) {
  const setting = (key) => settingOf(sources, key);
  const ignoreScripts = flag(setting("ignore-scripts"));
  // npm then fails an install holding a package with install scripts allow-scripts doesn't name,
  // before it runs any. pnpm's dlx runs the scripts of the packages it was asked for unasked, and
  // never fails on a dependency's.
  if (
    !ignoreScripts &&
    flag(setting("strict-allow-scripts")) &&
    !flag(setting("dangerously-allow-all-scripts"))
  ) {
    return { error: "strict-allow-scripts is set, and Eidolon's npx can't hold an install to it" };
  }
  const exotic = [setting("allow-git"), setting("allow-remote")];
  return [
    // npm runs every dependency's install scripts, or none under ignore-scripts; pnpm only those of
    // the packages asked for.
    ignoreScripts ? "--config.ignore-scripts=true" : "--config.dangerously-allow-all-builds=true",
    // npm takes the newest version that before or min-release-age allows; pnpm one at least a day
    // old.
    `--config.minimum-release-age=${releaseAge(sources, now)}`,
    // npm installs a dependency's own git and tarball-URL dependencies unless allow-git or
    // allow-remote is root or none; pnpm refuses them.
    `--config.block-exotic-subdeps=${exotic.some((allow) => allow === "root" || allow === "none")}`,
    // npm installs a flat node_modules, where a package finds what it uses without declaring it up
    // the folders, and the packages beside it at ../name. pnpm's isolated layout puts each package
    // among its own dependencies alone, and in its global virtual store an ES module finds the rest
    // only through a loader in NODE_OPTIONS, which the packaged app's Electron ignores.
    "--config.node-linker=hoisted",
    // npm reads no pnpmfile; pnpm runs the one of the workspace around the folder, or the home's,
    // whose hooks can rewrite what installs.
    "--config.ignore-pnpmfile=true",
    // npm takes registries from its variables, which pnpm never reads: a private package's name
    // would resolve on the registry pnpm falls back on. The user's .npmrc pnpm reads itself, and
    // the project's install writes for it.
    ...Object.entries(sources[0] ?? {})
      .filter(([key]) => key === "registry" || /^@[^:/]+:registry$/.test(key))
      .map(([key, value]) => `--config.${key}=${value}`),
  ];
}

/**
 * npx's arguments: the packages its -p and --package options name, then the command and the words
 * after it, which are the command's. An option this npx doesn't take is an error, named without
 * its value.
 * @param {readonly string[]} args
 * @returns {{ packages: string[], command: string[] } | { error: string }}
 */
export function readNpx(args) {
  const packages = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (DROPPED.has(arg)) continue;
    const option = arg.split("=", 1)[0];
    if (option === "-p" || option === "--package") {
      const name = option === arg ? args[++at] : arg.slice(option.length + 1);
      if (!name) return { error: `${option} needs a package` };
      packages.push(name);
      continue;
    }
    if (arg !== "--" && arg.startsWith("-"))
      return { error: `Eidolon's npx doesn't take ${option}` };
    const command = args.slice(arg === "--" ? at + 1 : at);
    if (command.length === 0) break;
    return { packages, command };
  }
  return { error: "nothing to run" };
}

const URL_SPEC = /^(?:git\+)?[a-z]+:/i;
const SCP_GIT_SPEC = /^[^@]+@[^:.]+\.[^:]+:.+$/i;
const TARBALL = /[.](?:tgz|tar\.gz|tar)$/i;
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;

/** Whether npm takes `name` for a package's, as validate-npm-package-name's validForOldPackages. */
function validName(name) {
  if (/^[.\-_]/.test(name) || name.trim() !== name || name === "") return false;
  if (["node_modules", "favicon.ico"].includes(name.toLowerCase())) return false;
  if (encodeURIComponent(name) === name) return true;
  const [, scope, base] = /^(?:@([^/]+?)[/])?([^/]+?)$/.exec(name) ?? [];
  return (
    base !== undefined &&
    !base.startsWith(".") &&
    scope !== undefined &&
    encodeURIComponent(scope) === scope &&
    encodeURIComponent(base) === base
  );
}

// The git hosts hosted-git-info knows, each with the protocols it takes for one and how it reads a
// URL's path.
const GIT_HOSTS = {
  github: {
    domain: "github.com",
    protocols: ["git:", "http:", "git+ssh:", "git+https:", "ssh:", "https:"],
    extract(url) {
      let [, user, project, type, committish] = url.pathname.split("/", 5);
      if (type && type !== "tree") return undefined;
      if (!type) committish = url.hash.slice(1);
      if (project?.endsWith(".git")) project = project.slice(0, -4);
      return user && project ? { user, project, committish } : undefined;
    },
  },
  bitbucket: {
    domain: "bitbucket.org",
    protocols: ["git+ssh:", "git+https:", "ssh:", "https:"],
    extract(url) {
      let [, user, project, aux] = url.pathname.split("/", 4);
      if (aux === "get") return undefined;
      if (project?.endsWith(".git")) project = project.slice(0, -4);
      return user && project ? { user, project, committish: url.hash.slice(1) } : undefined;
    },
  },
  gitlab: {
    domain: "gitlab.com",
    protocols: ["git+ssh:", "git+https:", "ssh:", "https:"],
    extract(url) {
      const whole = url.pathname.slice(1);
      if (whole.includes("/-/") || whole.includes("/archive.tar.gz")) return undefined;
      const segments = whole.split("/");
      let project = segments.pop();
      if (project.endsWith(".git")) project = project.slice(0, -4);
      const user = segments.join("/");
      return user && project ? { user, project, committish: url.hash.slice(1) } : undefined;
    },
  },
  gist: {
    domain: "gist.github.com",
    protocols: ["git:", "git+ssh:", "git+https:", "ssh:", "https:"],
    extract(url) {
      let [, user, project, aux] = url.pathname.split("/", 4);
      if (aux === "raw") return undefined;
      if (!project) {
        if (!user) return undefined;
        project = user;
        user = null;
      }
      if (project.endsWith(".git")) project = project.slice(0, -4);
      return { user, project, committish: url.hash.slice(1) };
    },
  },
  sourcehut: {
    domain: "git.sr.ht",
    protocols: ["git+ssh:", "https:"],
    extract(url) {
      let [, user, project, aux] = url.pathname.split("/", 4);
      if (aux === "archive") return undefined;
      if (project?.endsWith(".git")) project = project.slice(0, -4);
      return user && project ? { user, project, committish: url.hash.slice(1) } : undefined;
    },
  },
};
const GIT_PROTOCOLS = {
  "git+ssh:": { name: "sshurl" },
  "ssh:": { name: "sshurl" },
  "git+https:": { name: "https", auth: true },
  "git:": { auth: true },
  "http:": { auth: true },
  "https:": { auth: true },
  "git+http:": { auth: true },
  ...Object.fromEntries(Object.keys(GIT_HOSTS).map((type) => [`${type}:`, { name: type }])),
};

const parseUrl = (text) => {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
};

/** The last `char` in `text` before the first `before`, as hosted-git-info looks for one. */
const lastBefore = (text, char, before) => {
  const end = text.indexOf(before);
  return text.lastIndexOf(char, end > -1 ? end : Number.POSITIVE_INFINITY);
};

/** A git URL as hosted-git-info parses one, an scp-like `host:path` turned into a URL's path. */
function parseGitUrl(giturl) {
  let withProtocol = giturl;
  const colon = giturl.indexOf(":");
  const at = giturl.indexOf("@");
  if (Object.hasOwn(GIT_PROTOCOLS, giturl.slice(0, colon + 1))) {
    // A protocol it knows.
  } else if (colon > -1 && giturl.slice(colon, colon + 3) === "://") {
    // A URL already.
  } else if (at > -1) {
    if (at > colon) withProtocol = `git+ssh://${giturl}`;
  } else {
    withProtocol = `${giturl.slice(0, colon + 1)}//${giturl.slice(colon + 1)}`;
  }
  let corrected = withProtocol;
  const lastColon = lastBefore(corrected, ":", "#");
  if (lastColon > lastBefore(corrected, "@", "#")) {
    corrected = `${corrected.slice(0, lastColon)}/${corrected.slice(lastColon + 1)}`;
  }
  if (lastBefore(corrected, ":", "#") === -1 && !corrected.includes("//")) {
    corrected = `git+ssh://${corrected}`;
  }
  return parseUrl(withProtocol) ?? parseUrl(corrected);
}

/** Whether `arg` is GitHub's user/repo shorthand, as hosted-git-info tells it from a path. */
function isGitHubShorthand(arg) {
  const hash = arg.indexOf("#");
  const slash = arg.indexOf("/");
  const second = arg.indexOf("/", slash + 1);
  const afterHash = (at) => at === -1 || (hash > -1 && at > hash);
  return (
    afterHash(/\s/.exec(arg)?.index ?? -1) &&
    slash > 0 &&
    (hash > -1 ? arg[hash - 1] !== "/" : !arg.endsWith("/")) &&
    !arg.startsWith(".") &&
    afterHash(arg.indexOf("@")) &&
    afterHash(arg.indexOf(":")) &&
    afterHash(second)
  );
}

/**
 * The spec npm-package-arg saves for the repo `giturl` names on a host hosted-git-info knows, in
 * the form it was given in; undefined for anything else.
 */
function hostedGit(giturl) {
  const parsed = parseGitUrl(isGitHubShorthand(giturl) ? `github:${giturl}` : giturl);
  if (parsed === undefined) return undefined;
  const hostname = parsed.hostname.replace(/^www\./, "");
  const shortcut = parsed.protocol.slice(0, -1);
  const type = Object.hasOwn(GIT_HOSTS, shortcut)
    ? shortcut
    : Object.keys(GIT_HOSTS).find((name) => GIT_HOSTS[name].domain === hostname);
  if (type === undefined) return undefined;
  const { domain, protocols, extract } = GIT_HOSTS[type];
  const auth =
    GIT_PROTOCOLS[parsed.protocol]?.auth && (parsed.username || parsed.password)
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}`
      : null;
  let repo;
  try {
    if (type === shortcut) {
      let pathname = parsed.pathname.replace(/^\//, "");
      pathname = pathname.slice(pathname.indexOf("@") + 1);
      const slash = pathname.lastIndexOf("/");
      const project = decodeURIComponent(pathname.slice(slash + 1)).replace(/\.git$/, "");
      repo = {
        user: slash > -1 ? decodeURIComponent(pathname.slice(0, slash)) || null : null,
        project,
        committish: parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : null,
        form: "shortcut",
      };
    } else {
      const segments = protocols.includes(parsed.protocol) ? extract(parsed) : undefined;
      if (segments === undefined) return undefined;
      repo = {
        user: segments.user && decodeURIComponent(segments.user),
        project: decodeURIComponent(segments.project),
        committish: decodeURIComponent(segments.committish),
        form: GIT_PROTOCOLS[parsed.protocol]?.name || parsed.protocol.slice(0, -1),
      };
    }
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
  const { user, project, committish, form } = repo;
  const hash = committish ? `#${committish}` : "";
  const where = type === "gist" ? project : `${user}/${project}`;
  const login = type === "gist" || !auth ? "" : `${auth}@`;
  if (form === "shortcut") return `${type}:${where}${hash}`;
  if (form === "https" && type === "sourcehut") return `https://${domain}/${where}${hash}`;
  if (form === "https") return `git+https://${login}${domain}/${where}.git${hash}`;
  if (form === "git") return `git://${login}${domain}/${where}.git${hash}`;
  // hosted-git-info writes a form it has no template for as its git+ssh URL.
  return `git+ssh://git@${domain}/${where}.git${hash}`;
}

/** The characters npm-package-arg encodes in a path it makes a file: URL of. */
const FILE_URL_CHARS = {
  "\0": "%00",
  "\t": "%09",
  "\n": "%0A",
  "\r": "%0D",
  " ": "%20",
  '"': "%22",
  "#": "%23",
  "%": "%25",
  "?": "%3F",
  "[": "%5B",
  "]": "%5D",
  "^": "%5E",
  "|": "%7C",
  "~": "%7E",
};

/** `text` as a file: URL, as npm-package-arg makes one of a path. */
function fileUrl(text, windows) {
  let url = "";
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    url += char === "\\" ? (windows ? "/" : "%5C") : (FILE_URL_CHARS[char] ?? char);
  }
  return url.startsWith("file:") ? url : `file:${url}`;
}

/**
 * What npm-package-arg makes of `arg` from the folder `where`: its type (`git`, `remote`, `file`,
 * `directory`, `alias` or `registry`), the name it gives, the spec npm saves for a git one, and the
 * path of a file or folder; undefined where npm-package-arg throws.
 */
export function npmSpec(arg, where, home, platform = process.platform) {
  const windows = platform === "win32";
  const slashes = windows ? /\\|[/]/ : /[/]/;
  const nameEndsAt = arg.indexOf("@", 1);
  const namePart = nameEndsAt > 0 ? arg.slice(0, nameEndsAt) : arg;
  let name;
  let spec = arg;
  if (URL_SPEC.test(arg)) {
    // A URL, or a Windows path with its drive.
  } else if (SCP_GIT_SPEC.test(arg)) {
    spec = `git+ssh://${arg}`;
  } else if (!namePart.startsWith("@") && (slashes.test(namePart) || TARBALL.test(namePart))) {
    // A path, @ and all.
  } else if (nameEndsAt > 0) {
    name = namePart;
    spec = arg.slice(nameEndsAt + 1) || "*";
  } else if (validName(arg)) {
    name = arg;
    spec = "*";
  }
  if (name !== undefined && !validName(name)) return undefined;
  const fileSpec =
    /^file:/i.test(spec) ||
    (windows ? /^(?:[.]|~[/]|[/\\]|[a-zA-Z]:)/ : /^(?:[.]|~[/]|[/]|[a-zA-Z]:)/).test(spec);
  if (!fileSpec) {
    if (/^npm:/i.test(spec)) return { type: "alias", name };
    const hosted = hostedGit(spec);
    if (hosted !== undefined) return { type: "git", name, saveSpec: hosted };
    if (URL_SPEC.test(spec)) {
      const scp = spec.startsWith("git+ssh:")
        ? /^git\+ssh:\/\/([^:#]+:[^#]+(?:\.git)?)(?:#(.*))?$/i.exec(spec)
        : null;
      const url = parseUrl(spec.startsWith("git+file://") ? spec.replace(/\\/g, "/") : spec);
      if (
        (scp !== null && !/:[0-9]+(\/|$)/.test(scp[1])) ||
        /^git(?:\+(?:https?|rsync|ftp|file|ssh))?:$/.test(url?.protocol ?? "")
      ) {
        return { type: "git", name, saveSpec: spec };
      }
      if (url?.protocol === "http:" || url?.protocol === "https:") return { type: "remote", name };
      return undefined;
    }
    if (!slashes.test(spec) && !TARBALL.test(spec)) return { type: "registry", name };
  }
  const paths = windows ? path.win32 : path.posix;
  let raw = fileUrl(spec, windows);
  // file://x is file:/x, and file:/../x relative.
  if (/^file:\/\/[^/]/.test(raw)) raw = `file:/${raw.slice(5)}`;
  if (/^file:\/{1,3}\.\.?(\/|$)/.test(raw)) raw = raw.replace(/^file:\/{1,3}/, "file:");
  try {
    const own = decodeURIComponent(new URL(raw).pathname);
    const base = `${fileUrl(paths.resolve(where), windows)}/`;
    let resolved = decodeURIComponent(new URL(raw, base).pathname);
    if (windows) resolved = resolved.replace(/^\/+([a-z]:\/)/i, "$1");
    if (/^\/~(\/|$)/.test(own)) resolved = paths.resolve(home, own.slice(3));
    return {
      type: TARBALL.test(spec) ? "file" : "directory",
      name,
      path: paths.resolve(where, resolved),
    };
  } catch {
    return undefined;
  }
}

/**
 * The folder or tarball file `spec` names, as npm-package-arg tells them from a git repo, a URL or
 * a registry package, with the name it gives it, if any; undefined for anything else.
 */
export function localSpec(spec, cwd, home, platform = process.platform) {
  const parsed = npmSpec(spec, cwd, home, platform);
  if (parsed?.type !== "file" && parsed?.type !== "directory") return undefined;
  return { name: parsed.name, path: parsed.path, tarball: parsed.type === "file" };
}

const ALLOWS = {
  git: "allow-git",
  remote: "allow-remote",
  file: "allow-file",
  directory: "allow-directory",
};

/**
 * npm's error, as it prints it, for the first of `specs` whose kind its allow-git, allow-remote,
 * allow-file or allow-directory setting in `sources` is none, if any. Those npx asks for are the
 * root's, which root lets through.
 */
export function refusal(specs, sources, cwd, home, platform = process.platform) {
  for (const spec of specs) {
    const { type, name, saveSpec } = npmSpec(spec, cwd, home, platform) ?? {};
    if (!Object.hasOwn(ALLOWS, type) || settingOf(sources, ALLOWS[type]) !== "none") continue;
    const lines = [
      `code EALLOW${type.toUpperCase()}`,
      `Fetching packages of type "${type}" have been disabled`,
    ];
    if (type === "git") lines.push(`Refusing to fetch "${name ? `${name}@` : ""}${saveSpec}"`);
    return lines.join("\n");
  }
  return undefined;
}

/**
 * pnpm's arguments to install `packages` into its dlx cache as npx would, with npxSettings'
 * `settings`: npm links a folder it is given rather than installing it and its dependencies, as
 * pnpm does with link:. pnpm reads a relative path from its dlx folder, so each local one goes
 * absolute.
 * @param {readonly string[]} packages
 * @param {readonly string[]} settings
 * @returns {string[]}
 */
export function npxToPnpm(packages, settings, cwd, home, platform = process.platform) {
  const specs = packages.map((spec) => {
    const local = localSpec(spec, cwd, home, platform);
    if (local === undefined) return spec;
    const name = local.name === undefined ? "" : `${local.name}@`;
    return `${name}${local.tarball ? "file" : "link"}:${local.path}`;
  });
  // pnpm keys a dlx install by its packages and --allow-build, never by these settings, so for a
  // day pnpx's or pnpm dlx's install of a package would serve npx, and npx's them, and one npx's
  // another's under other settings. A name no package can have, made from them, keys each apart.
  const key = createHash("sha256").update(settings.join("\n")).digest("hex").slice(0, 16);
  return [
    "--loglevel=error",
    ...settings,
    "dlx",
    `--allow-build=.npx-${key}`,
    ...specs.map((spec) => `--package=${spec}`),
  ];
}

function stat(file) {
  try {
    return statSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

const isFile = (file) => stat(file)?.isFile() === true;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

/** A manifest's bins, named and pointing inside the package `dir` as npm normalizes them. */
export function binsOf(manifest, dir) {
  let { bin } = manifest;
  if (!bin && typeof manifest.directories?.bin === "string" && manifest.directories.bin) {
    const folder = path.posix.join("/", manifest.directories.bin.replace(/\\/g, "/")).slice(1);
    const root = path.resolve(dir, folder);
    let entries = [];
    // npm's glob enters no link. A recursive readdir follows one to a folder, and two links back
    // into it never end.
    try {
      entries = globSync("**", { cwd: root, withFileTypes: true });
    } catch {}
    bin = {};
    for (const entry of entries) {
      const file = path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/");
      if (entry.isFile() && !file.startsWith(".")) bin[entry.name] = `${folder}/${file}`;
    }
  } else if (typeof bin === "string") {
    bin = typeof manifest.name === "string" ? { [manifest.name]: bin } : undefined;
  } else if (Array.isArray(bin)) {
    bin = Object.fromEntries(
      bin.filter((file) => typeof file === "string").map((file) => [path.basename(file), file]),
    );
  }
  const clean = {};
  if (bin === null || typeof bin !== "object") return clean;
  for (const [key, value] of Object.entries(bin)) {
    const name = path.posix.join("/", path.posix.basename(key.replace(/\\|:/g, "/"))).slice(1);
    if (typeof value !== "string" || !name) continue;
    const file = path.posix.join("/", value.replace(/\\/g, "/")).slice(1);
    if (file) clean[name] = file;
  }
  return clean;
}

/** The bin npm runs from a package given no command, or undefined where npm can't tell which. */
export function binOf(manifest, dir) {
  const bins = binsOf(manifest, dir);
  if (new Set(Object.values(bins)).size === 1) return Object.keys(bins)[0];
  const own = String(manifest.name ?? "").replace(/^@[^/]+\//, "");
  return Object.hasOwn(bins, own) ? own : undefined;
}

/** npm's reading of `pattern` as a glob, for workspaces' paths. */
const matches = (relative, pattern) =>
  path.posix.matchesGlob(relative, pattern.replace(/\/+$/, ""));

/** Whether `dir` is one of the workspaces the package.json in `root` declares, as npm maps them. */
function isWorkspace(root, dir) {
  const declared = readJson(path.join(root, "package.json"))?.workspaces;
  const list = Array.isArray(declared?.packages) ? declared.packages : declared;
  if (!Array.isArray(list) || !isFile(path.join(dir, "package.json"))) return false;
  const relative = path.relative(root, dir).split(path.sep).join("/");
  if (relative.split("/").includes("node_modules")) return false;
  const patterns = [];
  let negated = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const bangs = /^!+/.exec(entry)?.[0].length ?? 0;
    const pattern = entry
      .slice(bangs)
      .replace(/^\.?\/+/, "")
      .replace(/\\/g, "/");
    if (bangs % 2 === 1) {
      negated.push(pattern);
    } else {
      // A pattern brings back what a negation before it left out.
      negated = negated.filter((left) => !matches(pattern, left));
      patterns.push(pattern);
    }
  }
  return (
    patterns.some(
      (pattern) => !negated.some((left) => matches(pattern, left)) && matches(relative, pattern),
    ) && !negated.some((left) => matches(relative, left))
  );
}

/**
 * npm's local prefix from `cwd`: the first folder up with a package.json or a node_modules, or
 * the root of the workspaces it is one of, with `workspace` then that first folder.
 */
export function npmPrefix(cwd) {
  let found;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const hasManifest = isFile(path.join(dir, "package.json"));
    if (found === undefined) {
      if (hasManifest || stat(path.join(dir, "node_modules"))?.isDirectory()) found = dir;
    } else if (hasManifest && isWorkspace(dir, found)) {
      return { prefix: dir, workspace: found };
    }
    if (path.dirname(dir) === dir)
      return { prefix: found ?? path.resolve(cwd), workspace: undefined };
  }
}

/** The node_modules/.bin from `start` up that holds `name`, as libnpmexec's localFileExists. */
export function localBin(start, name) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const bin = path.join(dir, "node_modules", ".bin");
    if (isFile(path.resolve(bin, name))) return bin;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The workspaces the package.json in `root` declares, as npm maps them. */
function workspacesOf(root) {
  const declared = readJson(path.join(root, "package.json"))?.workspaces;
  const list = Array.isArray(declared?.packages) ? declared.packages : declared;
  if (!Array.isArray(list)) return [];
  const found = new Set();
  for (const entry of list) {
    if (typeof entry !== "string" || (/^!+/.exec(entry)?.[0].length ?? 0) % 2 === 1) continue;
    const pattern = entry
      .replace(/^!+/, "")
      .replace(/^\.?\/+/, "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    let dirs = [];
    try {
      dirs = globSync(pattern, {
        cwd: root,
        exclude: (name) => path.basename(name) === "node_modules",
      });
    } catch {}
    for (const dir of dirs)
      if (isWorkspace(root, path.join(root, dir))) found.add(path.join(root, dir));
  }
  return [...found];
}

/** The package folders in the node_modules `dir`, scoped ones too, as Arborist reads them. */
function packagesIn(dir) {
  const names = (folder) => {
    try {
      return readdirSync(folder).filter((name) => !name.startsWith("."));
    } catch {
      return [];
    }
  };
  return names(dir).flatMap((name) =>
    name.startsWith("@")
      ? names(path.join(dir, name)).map((inner) => path.join(dir, name, inner))
      : [path.join(dir, name)],
  );
}

/**
 * npm's local tree at `prefix`, as Arborist loads it: the project, its workspaces, and every
 * package in a node_modules below them, a link's target too, nearest first.
 */
export function treePackages(prefix) {
  const packages = [];
  const seen = new Set();
  const queue = [prefix, ...workspacesOf(prefix)];
  for (const dir of queue) {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const manifest = readJson(path.join(real, "package.json"));
    if (typeof manifest?.name === "string") packages.push({ dir: real, manifest });
    queue.push(...packagesIn(path.join(real, "node_modules")));
  }
  return packages;
}

let loadedSemver;
/** npm's semver, which the pnpm here carries for node-gyp. */
function semver() {
  loadedSemver ??= createRequire(import.meta.url)("../node_modules/pnpm/dist/node_modules/semver");
  return loadedSemver;
}

/**
 * The package of `packages` that `spec` names, as libnpmexec's missingFromTree finds one in the
 * local tree, which npm then runs rather than install: by its package.json's name, at any version
 * for a name alone, or one the version or range allows. A tag, an alias, or a spec that isn't a
 * registry's, it never finds there.
 */
export function inTree(packages, spec) {
  const at = spec.indexOf("@", 1);
  const name = at > 0 ? spec.slice(0, at) : spec;
  const wanted = at > 0 ? spec.slice(at + 1) || "*" : "*";
  if (!PACKAGE_NAME.test(name) || TARBALL.test(name)) return undefined;
  const named = packages.filter(({ manifest }) => manifest.name === name);
  if (wanted === "*") return named[0];
  if (named.length === 0 || semver().validRange(wanted.trim(), true) === null) return undefined;
  return named.find(
    ({ manifest }) =>
      `${name}@${manifest.version}` === spec || semver().satisfies(manifest.version, wanted),
  );
}

/**
 * What npx does with `args` from `cwd`, as libnpmexec decides it: the command, `undefined` for
 * the bin of the one package `install` names, the folders whose bins come first on its PATH, and
 * the folder it runs in; `install` lists what isn't here yet. An error carries npm's exit code.
 * `env` and `home` give npm's config.
 */
export function plan(args, cwd, home = homedir(), env = process.env) {
  const read = readNpx(args);
  if ("error" in read) return read;
  const { prefix, workspace } = npmPrefix(cwd);
  const runPath = workspace ?? cwd;
  const trees = workspace === undefined ? [prefix] : [workspace, prefix];
  let tree;
  const inLocalTree = (spec) => {
    tree ??= treePackages(prefix);
    return inTree(tree, spec);
  };
  let [command, ...rest] = read.command;
  let packages = read.packages;
  let own;
  if (packages.length === 0) {
    own = trees.find((dir) => {
      const manifest = readJson(path.join(dir, "package.json"));
      return manifest !== undefined && Object.hasOwn(binsOf(manifest, dir), command);
    });
    if (own !== undefined) {
      // npm installs the project as a link and runs its bin, whatever allow-directory says.
      packages = [own];
    } else {
      const bin = localBin(trees[0], command);
      if (bin !== undefined) return { command, args: rest, bins: [bin], runPath };
      const found = inLocalTree(command);
      if (found !== undefined) {
        const name = binOf(found.manifest, found.dir);
        if (name === undefined) return { error: "could not determine executable to run" };
        return { command: name, args: rest, bins: [], runPath };
      }
      packages = [command];
      command = undefined;
    }
  }
  // npm refuses one before it looks for it in the local tree.
  if (own === undefined) {
    const refused = refusal(packages, npmConfig(env, prefix, home), cwd, home);
    if (refused !== undefined) return { error: refused, code: 1 };
  }
  const install = packages.filter((spec) => inLocalTree(spec) === undefined);
  for (const spec of install) {
    const local = localSpec(spec, cwd, home);
    if (local === undefined) continue;
    try {
      readFileSync(local.tarball ? local.path : path.join(local.path, "package.json"));
    } catch (error) {
      const what = local.tarball ? "the tarball" : "package.json";
      return { error: `could not read ${what}: ${error.message}`, code: error.errno ?? 1 };
    }
  }
  return { ...(install.length > 0 ? { install } : {}), command, args: rest, bins: [], runPath };
}

/** The env's PATH as npm reads it: each key Windows may spell it with, joined in order. */
export function pathOf(env, delimiter = path.delimiter) {
  return Object.keys(env)
    .filter((key) => /^path$/i.test(key) && env[key])
    .map((key) => env[key].split(delimiter))
    .reduce((dirs, more) => dirs.concat(more.filter((dir) => !dirs.includes(dir))), [])
    .join(delimiter);
}

/** npm's PATH: `bins`, each node_modules/.bin from `runPath` up, then node-gyp's and `rest`. */
export function npmPath(bins, runPath, nodeGyp, rest, delimiter = path.delimiter) {
  const dirs = [...bins];
  for (let dir = runPath; ; dir = path.dirname(dir)) {
    dirs.push(path.resolve(dir, "node_modules", ".bin"));
    if (path.dirname(dir) === dir) break;
  }
  return [...dirs, nodeGyp, rest].join(delimiter);
}

/**
 * The command's environment: `env` with every key that spells PATH set to `value`, and without
 * ELECTRON_RUN_AS_NODE, which npm doesn't set: the launchers set it again for what they run on
 * Eidolon's binary, and anything else, VS Code's `code` say, would run as Node with it.
 */
export function commandEnv(env, value) {
  const kept = Object.entries(env).filter(([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE");
  const keys = kept.map(([key]) => key).filter((key) => /^path$/i.test(key));
  return {
    ...Object.fromEntries(kept),
    ...Object.fromEntries((keys.length > 0 ? keys : ["PATH"]).map((key) => [key, value])),
  };
}

const envValue = (env, name) =>
  Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];

/**
 * The file `command` names, searched for from `cwd` on `pathEnv` as sh does: the first executable
 * one, or with none the first there, which sh then fails to run. On Windows as cmd.exe does
 * through PATHEXT, but never in the working folder first.
 */
export function which(command, { pathEnv, cwd, platform = process.platform, pathext }) {
  const windows = platform === "win32";
  const dirs = windows
    ? pathEnv
        .split(";")
        .filter(Boolean)
        .map((dir) => dir.replace(/^"(.*)"$/, "$1"))
    : pathEnv.split(":");
  const bases = (windows ? /[\\/]/ : /\//).test(command)
    ? [path.resolve(cwd, command)]
    : dirs.map((dir) => path.resolve(cwd, dir, command));
  if (!windows) {
    const files = bases.filter(isFile);
    const executable = files.find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    return executable ?? files[0];
  }
  const extensions = (pathext || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC")
    .split(";")
    .filter(Boolean);
  const tries = path.extname(command) === "" ? extensions : ["", ...extensions];
  for (const base of bases) {
    for (const extension of tries) {
      if (isFile(base + extension)) return base + extension;
    }
  }
  return undefined;
}

/**
 * How to start `file` without a shell: on Windows a .exe or .com directly, anything else through
 * cmd.exe, with a batch file's arguments escaped twice, as npm's npx escapes them.
 */
export function spawnArgs(file, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(file)) {
    return { command: file, args, verbatim: false };
  }
  const batch = /\.(?:cmd|bat)$/i.test(file);
  return { ...cmdLine(envValue(env, "ComSpec") ?? "cmd.exe", file, args, batch), verbatim: true };
}

/**
 * Passes SIGINT and SIGTERM on to `child`, as npm does to what it runs; returns the undo. On
 * Windows only waits for it: kill() there is TerminateProcess, and a console's Ctrl-C reaches the
 * child itself.
 */
export function relay(child, platform = process.platform) {
  const forward = platform === "win32" ? () => {} : (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return () => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  };
}

/** Ends as the child did: npm raises its signal again on itself, or exits with its code. */
function end(code, signal) {
  if (signal !== null && process.platform !== "win32") {
    process.kill(process.pid, signal);
    setTimeout(() => process.exit(1), 500);
    return;
  }
  process.exit(code ?? 1);
}

function fail(message, code = 1) {
  console.error(message.replace(/^/gm, "npx: "));
  process.exit(code);
}

/** The interpreter the #! line `file` starts with names, if it has one. */
function interpreterOf(file) {
  try {
    return /^#!\s*(\S+)/.exec(readFileSync(file, "latin1"))?.[1];
  } catch {
    return undefined;
  }
}

// The no-op pnpm runs once installed, which leaves its dlx folder's bins, first on its PATH.
const REPORT =
  'require("node:fs").writeFileSync(process.env.EIDOLON_NPX_REPORT, process.env.PATH ?? "")';

/** Installs `packages` in pnpm's dlx cache, resolving to its node_modules/.bin, or ends as pnpm. */
function install(packages) {
  const sources = npmConfig(process.env, npmPrefix(process.cwd()).prefix, homedir());
  const settings = npxSettings(sources);
  if ("error" in settings) fail(settings.error);
  const scratch = mkdtempSync(path.join(tmpdir(), "eidolon-npx-"));
  // pnpm reads the .npmrc of the project it finds itself in, not the one npm reads at its local
  // prefix, and expands no ${VAR} in one's registries or credentials. So it runs in a folder of
  // its own, with that .npmrc written there as npm reads it, and no pnpm workspace around it. The
  // folder is the user's alone, and goes once pnpm ends.
  const npmrc = projectNpmrc(sources[1] ?? {}, process.cwd(), homedir());
  if (npmrc) writeFileSync(path.join(scratch, ".npmrc"), `${npmrc}\n`, { mode: 0o600 });
  const report = path.join(scratch, "path");
  const pnpm = fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.mjs", import.meta.url));
  const args = [
    ...process.execArgv,
    pnpm,
    `--dir=${scratch}`,
    "--ignore-workspace",
    ...npxToPnpm(packages, settings, process.cwd(), homedir()),
    "--",
    process.execPath,
    ...process.execArgv,
    "-e",
    REPORT,
  ];
  // pnpm's stdout goes to stderr with its own, and it never reads the server's stdin.
  const child = spawn(process.execPath, args, {
    cwd: scratch,
    stdio: ["ignore", 2, 2],
    env: { ...process.env, EIDOLON_NPX_REPORT: report },
    windowsHide: true,
  });
  const undo = relay(child);
  return new Promise((resolve) => {
    child.on("error", (error) => fail(`couldn't start pnpm: ${error.message}`));
    child.on("exit", (code, signal) => {
      undo();
      let bin;
      try {
        bin = readFileSync(report, "utf8").split(path.delimiter)[0];
      } catch {}
      rmSync(scratch, { recursive: true, force: true });
      if (code === 0 && bin) resolve(bin);
      else end(code || 1, signal);
    });
  });
}

/** The packages npx installed in the dlx folder whose node_modules/.bin is `bin`, in order. */
function installed(bin) {
  const dir = path.dirname(path.dirname(bin));
  const names = Object.keys(readJson(path.join(dir, "package.json"))?.dependencies ?? {});
  return names.flatMap((name) => {
    const packageDir = path.join(dir, "node_modules", name);
    const manifest = readJson(path.join(packageDir, "package.json"));
    return manifest === undefined ? [] : [{ dir: packageDir, manifest }];
  });
}

if (import.meta.main) {
  const decided = plan(process.argv.slice(2), process.cwd());
  if ("error" in decided) fail(decided.error, decided.code);
  let { command, bins } = decided;
  if (decided.install !== undefined) {
    const bin = await install(decided.install);
    bins = [bin];
    const packages = installed(bin);
    // With no command named, npm picks the bin of the package installed: see binOf.
    command ??= packages[0] && binOf(packages[0].manifest, packages[0].dir);
    if (command === undefined) fail("could not determine executable to run");
    // pnpm links no bin whose name or path it won't take, which npm names and links as binsOf
    // does: a program of that name further down PATH would run in its place.
    const theirs = packages.some(({ manifest, dir }) =>
      Object.hasOwn(binsOf(manifest, dir), command),
    );
    if (theirs && !isFile(path.join(bin, command))) {
      fail(`${command}: pnpm doesn't link a bin by this name`, 127);
    }
  }
  const nodeGyp = fileURLToPath(new URL("../node_modules/pnpm/dist/node-gyp-bin", import.meta.url));
  const env = commandEnv(process.env, npmPath(bins, decided.runPath, nodeGyp, pathOf(process.env)));
  const file = which(command, {
    pathEnv: pathOf(env),
    cwd: decided.runPath,
    pathext: envValue(env, "PATHEXT"),
  });
  if (file === undefined) {
    // As cmd.exe or sh would end.
    if (process.platform === "win32") fail(`'${command}' is not recognized as a command`);
    fail(`${command}: command not found`, 127);
  }
  const start = spawnArgs(file, decided.args, { env });
  const options = {
    cwd: decided.runPath,
    env,
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: start.verbatim,
  };
  let child;
  try {
    child = spawn(start.command, start.args, options);
  } catch (error) {
    // Node throws ENOEXEC rather than emit it. sh runs a file the system can't, one without a #!
    // line, as a script of its own.
    if (error.code !== "ENOEXEC" || process.platform === "win32") {
      fail(`${command}: ${error.message}`, 126);
    }
    child = spawn("/bin/sh", [file, ...decided.args], options);
  }
  const undo = relay(child);
  child.on("error", (error) => {
    // spawn reports a script whose #! interpreter isn't there as the script missing; sh names the
    // interpreter and ends 126.
    const interpreter =
      error.code === "ENOENT" && process.platform !== "win32" ? interpreterOf(file) : undefined;
    if (interpreter !== undefined) {
      fail(`${command}: ${interpreter}: bad interpreter: No such file or directory`, 126);
    }
    fail(`${command}: ${error.message}`, error.code === "EACCES" ? 126 : 127);
  });
  child.on("exit", (code, signal) => {
    undo();
    end(code, signal);
  });
}
