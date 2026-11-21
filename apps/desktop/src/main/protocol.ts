// The eidolon-app: scheme the window loads. Its shell host serves the packaged pages main shows
// while there is no backend to show; every other host is a 404 for now.
import { readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { app, protocol } from "electron";

export const SCHEME = "eidolon-app";
export const LOADING_PAGE = `${SCHEME}://shell/loading`;

/**
 * Only before `ready`, and only once. `standard` gives the page a tuple origin with storage,
 * `secure` the secure context getUserMedia needs, and `stream` lets `<audio>` play a streamed answer.
 */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

const SHELL_CSP = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** A page by its name (`/loading`), or one of the assets its build links. */
async function shellFile(pathname: string): Promise<Response> {
  const root = join(app.getAppPath(), "dist", "shell");
  const file = join(root, extname(pathname) === "" ? `${pathname}.html` : pathname);
  const type = TYPES[extname(file)];
  if (type === undefined || relative(root, file).split(sep).includes("..")) {
    return new Response(null, { status: 404 });
  }
  try {
    return new Response(await readFile(file), {
      headers: { "content-type": type, "content-security-policy": SHELL_CSP },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/** Serves the scheme on the default session; after `ready`. */
export function handleScheme(): void {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host === "shell" && request.method === "GET") return shellFile(url.pathname);
    return new Response(null, { status: 404 });
  });
}
