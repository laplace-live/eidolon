// Copyright (c) npm, Inc.
// Copyright (c) 2015, npm, Inc
// Copyright (c) 2015, Rebecca Turner
// SPDX-License-Identifier: ISC
//
// Ported from npm-package-arg lib/npa.js@13.0.2, validate-npm-package-name lib/index.js@7.0.2
// and hosted-git-info lib/index.js, lib/hosts.js, lib/from-url.js and lib/parse-url.js@9.0.3
//
// What a spec npx is given names, as npm tells a registry package from an alias, a git repo, a URL,
// a tarball or a folder.
import path from "node:path";

const URL_SPEC = /^(?:git\+)?[a-z]+:/i;
const SCP_GIT_SPEC = /^[^@]+@[^:.]+\.[^:]+:.+$/i;
export const TARBALL = /[.](?:tgz|tar\.gz|tar)$/i;

export type ParsedSpec =
  | { readonly type: "alias" | "remote" | "registry"; readonly name: string | undefined }
  | { readonly type: "git"; readonly name: string | undefined; readonly saveSpec: string }
  | {
      readonly type: "file" | "directory";
      readonly name: string | undefined;
      readonly path: string;
    };

/** Whether npm takes `name` for a package's, as validate-npm-package-name's validForOldPackages. */
function validName(name: string): boolean {
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

interface ExtractedGit {
  readonly user: string | null;
  readonly project: string;
  readonly committish: string | undefined;
}

interface GitHost {
  readonly domain: string;
  readonly protocols: readonly string[];
  extract(url: URL): ExtractedGit | undefined;
}

// The git hosts hosted-git-info knows, each with the protocols it takes for one and how it reads a
// URL's path.
const GIT_HOSTS: Readonly<Record<string, GitHost>> = {
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
      let project = segments.pop() ?? "";
      if (project.endsWith(".git")) project = project.slice(0, -4);
      const user = segments.join("/");
      return user && project ? { user, project, committish: url.hash.slice(1) } : undefined;
    },
  },
  gist: {
    domain: "gist.github.com",
    protocols: ["git:", "git+ssh:", "git+https:", "ssh:", "https:"],
    extract(url) {
      let [, rawUser, project, aux] = url.pathname.split("/", 4);
      if (aux === "raw") return undefined;
      let user: string | null = rawUser ?? null;
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
const GIT_PROTOCOLS: Readonly<Record<string, { readonly name?: string; readonly auth?: boolean }>> =
  {
    "git+ssh:": { name: "sshurl" },
    "ssh:": { name: "sshurl" },
    "git+https:": { name: "https", auth: true },
    "git:": { auth: true },
    "http:": { auth: true },
    "https:": { auth: true },
    "git+http:": { auth: true },
    ...Object.fromEntries(Object.keys(GIT_HOSTS).map((type) => [`${type}:`, { name: type }])),
  };

/** The last `char` in `text` before the first `before`, as hosted-git-info looks for one. */
const lastBefore = (text: string, char: string, before: string): number => {
  const end = text.indexOf(before);
  return text.lastIndexOf(char, end > -1 ? end : Number.POSITIVE_INFINITY);
};

/** A git URL as hosted-git-info parses one, an scp-like `host:path` turned into a URL's path. */
function parseGitUrl(giturl: string): URL | null {
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
  return URL.parse(withProtocol) ?? URL.parse(corrected);
}

/** Whether `arg` is GitHub's user/repo shorthand, as hosted-git-info tells it from a path. */
function isGitHubShorthand(arg: string): boolean {
  const hash = arg.indexOf("#");
  const slash = arg.indexOf("/");
  const second = arg.indexOf("/", slash + 1);
  const afterHash = (at: number) => at === -1 || (hash > -1 && at > hash);
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
 * the form it was given in but with its password shown as `***`; undefined for anything else.
 */
function hostedGit(giturl: string): string | undefined {
  const parsed = parseGitUrl(isGitHubShorthand(giturl) ? `github:${giturl}` : giturl);
  if (parsed === null) return undefined;
  const hostname = parsed.hostname.replace(/^www\./, "");
  const shortcut = parsed.protocol.slice(0, -1);
  const type = Object.hasOwn(GIT_HOSTS, shortcut)
    ? shortcut
    : Object.keys(GIT_HOSTS).find((name) => GIT_HOSTS[name]?.domain === hostname);
  if (type === undefined) return undefined;
  const { domain, protocols, extract } = GIT_HOSTS[type] as GitHost;
  // npx only prints this spec, and hides the password as npm's log does: an MCP server's stderr
  // reaches the task. npm prints this one as it was given.
  const auth =
    GIT_PROTOCOLS[parsed.protocol]?.auth && (parsed.username || parsed.password)
      ? `${parsed.username}${parsed.password ? ":***" : ""}`
      : null;
  let repo: {
    user: string | null;
    project: string;
    committish: string | null;
    form: string;
  };
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
        user: segments.user ? decodeURIComponent(segments.user) : segments.user,
        project: decodeURIComponent(segments.project),
        committish: decodeURIComponent(segments.committish ?? ""),
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
const FILE_URL_CHARS: Readonly<Record<string, string>> = {
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
function fileUrl(text: string, windows: boolean): string {
  let url = "";
  for (let at = 0; at < text.length; at++) {
    const char = text[at] as string;
    url += char === "\\" ? (windows ? "/" : "%5C") : (FILE_URL_CHARS[char] ?? char);
  }
  return url.startsWith("file:") ? url : `file:${url}`;
}

/**
 * What npm-package-arg makes of `arg` from the folder `where`: its type (`git`, `remote`, `file`,
 * `directory`, `alias` or `registry`), the name it gives, the spec npm saves for a git one, and the
 * path of a file or folder; undefined where npm-package-arg throws.
 */
export function npmSpec(
  arg: string,
  where: string,
  home: string,
  platform: string = process.platform,
): ParsedSpec | undefined {
  const windows = platform === "win32";
  const slashes = windows ? /\\|[/]/ : /[/]/;
  const nameEndsAt = arg.indexOf("@", 1);
  const namePart = nameEndsAt > 0 ? arg.slice(0, nameEndsAt) : arg;
  let name: string | undefined;
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
      const url = URL.parse(spec.startsWith("git+file://") ? spec.replace(/\\/g, "/") : spec);
      if (
        (scp !== null && !/:[0-9]+(\/|$)/.test(scp[1] as string)) ||
        /^git(?:\+(?:https?|rsync|ftp|file|ssh))?:$/.test(url?.protocol ?? "")
      ) {
        // Its password hidden, as a hosted one's.
        const saveSpec = spec.replace(/^([^:/?#]+:\/\/[^/?#@:]*:)[^/?#]+@/, "$1***@");
        return { type: "git", name, saveSpec };
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
