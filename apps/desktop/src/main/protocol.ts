// The eidolon-app: scheme the window loads. Its shell host serves the pages main shows while there
// is no backend to show; every other host is a 404 for now.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, protocol } from "electron";
import { SCHEME } from "../shared/bridge.ts";
import {
  type RenderedPage,
  renderFailedPage,
  renderLoadingPage,
  renderWaitingPage,
  type ShellFailure,
  type ShellPageName,
  type ShellPageStrings,
  shellRoute,
} from "./shell-pages.ts";

export { SCHEME };
export const LOADING_PAGE = `${SCHEME}://shell/loading`;
export const FAILED_PAGE = `${SCHEME}://shell/failed`;

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

/** What the shell pages show, asked each time one is served. */
export interface ShellPages {
  /** Their strings, in the app's language. */
  readonly strings: () => ShellPageStrings;
  /** What the failure page says went wrong. */
  readonly failure: () => ShellFailure;
}

const notFound = (): Response => new Response(null, { status: 404 });

function shellFile(name: string): string {
  return join(app.getAppPath(), "dist", "shell", name);
}

function pageResponse({ html, csp }: RenderedPage, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
    },
  });
}

async function template(page: ShellPageName): Promise<string | null> {
  try {
    return await readFile(shellFile(`${page}.html`), "utf8");
  } catch {
    return null;
  }
}

/** A shell page by its name (`/loading`), filled in, or an asset the pages' build links. */
export async function shellResponse(url: URL, pages: ShellPages): Promise<Response> {
  const route = shellRoute(url.pathname);
  if (route === null) return notFound();
  if ("asset" in route) {
    try {
      const body = await readFile(shellFile(join("assets", route.asset)));
      return new Response(body, {
        headers: { "content-type": route.type, "x-content-type-options": "nosniff" },
      });
    } catch {
      return notFound();
    }
  }
  const html = await template(route.page);
  if (html === null) return notFound();
  return pageResponse(
    route.page === "failed"
      ? renderFailedPage(html, pages.strings(), pages.failure())
      : renderLoadingPage(html, pages.strings()),
  );
}

/**
 * The answer to a document request at the app's address while there is no backend: a page that
 * waits, in place, for main to reload the window once one answers.
 */
export async function waitingPage(strings: ShellPageStrings): Promise<Response> {
  const html = await template("waiting");
  if (html === null) return new Response(null, { status: 503 });
  return pageResponse(renderWaitingPage(html, strings), 503);
}

/** Serves the scheme on the default session; after `ready`. */
export function handleScheme(pages: ShellPages): void {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host === "shell" && request.method === "GET") return shellResponse(url, pages);
    return notFound();
  });
}
