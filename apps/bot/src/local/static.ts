// The built web app (apps/web/dist), read into memory once at boot as a map of URL path → file.
// A request is answered from that map or with index.html; its path is never decoded or joined to
// a filesystem path, so no spelling of `..` reaches outside the build.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { webDist } from "@eidolon/config";
import { isInside } from "./write.ts";

/**
 * `blob:` lets the WebRTC client load its AudioWorklets, and `https:` lets voice covers and
 * samples load from Fish. same-origin, not no-referrer: under no-referrer a page's own POSTs send
 * `Origin: null`, which the API refuses.
 */
export const STATIC_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy":
    "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; " +
    "media-src 'self' blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
});

/** Vite fingerprints everything under /assets/, so a name never changes content. */
const IMMUTABLE = "public, max-age=31536000, immutable";

export class MissingDist extends Error {
  override readonly name = "MissingDist";
}

interface StaticFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly type: string;
  readonly etag: string;
  readonly cache: string;
}

export interface StaticSite {
  /** Every path the map holds, for tests. */
  readonly paths: readonly string[];
  /** The answer to a GET or HEAD for `pathname`, exactly as the request spelled it. */
  respond(pathname: string, request: Request): Response;
}

// A segment a URL path spells the same way: no escape, query, fragment or backslash.
const PLAIN_SEGMENT = /^[^%?#\\\p{Cc}]+$/u;

function load(path: string, urlPath: string): StaticFile {
  const bytes = new Uint8Array(readFileSync(path));
  return {
    bytes,
    type: Bun.file(path).type,
    etag: `"${Bun.hash(bytes).toString(36)}"`,
    cache: urlPath.startsWith("/assets/") ? IMMUTABLE : "no-cache",
  };
}

/** Walks `dist` once. Files only; anything whose real path leaves `dist` is skipped. */
export function loadStaticSite(dist = webDist()): StaticSite {
  let root: string;
  try {
    root = realpathSync(dist);
    statSync(join(root, "index.html"));
  } catch {
    throw new MissingDist(`The web app is not built: ${dist} has no index.html`);
  }
  const files = new Map<string, StaticFile>();
  const visited = new Set([root]);
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || !PLAIN_SEGMENT.test(name)) continue;
      let real: string;
      try {
        real = realpathSync(join(dir, name));
      } catch {
        continue;
      }
      if (!isInside(real, root)) continue;
      const stat = statSync(real);
      const urlPath = new URL(`${prefix}/${name}`, "http://local").pathname;
      if (stat.isDirectory()) {
        if (!visited.has(real)) {
          visited.add(real);
          visit(join(dir, name), urlPath);
        }
      } else if (stat.isFile()) {
        files.set(urlPath, load(real, urlPath));
      }
    }
  };
  visit(root, "");
  const index = files.get("/index.html");
  if (index === undefined) throw new MissingDist(`${dist}/index.html is not a file in the build`);

  return {
    paths: [...files.keys()],
    respond(pathname, request) {
      const file = files.get(pathname) ?? index;
      const headers = {
        ...STATIC_HEADERS,
        "content-type": file.type,
        "cache-control": file.cache,
        etag: file.etag,
      };
      if (request.headers.get("if-none-match") === file.etag) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(file.bytes, { headers });
    },
  };
}
