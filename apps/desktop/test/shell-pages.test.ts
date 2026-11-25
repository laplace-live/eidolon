import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { describe, expect, test } from "vitest";
import { scan } from "../../bot/test/local/scan.ts";
import { shellPages } from "../scripts/vite-common.ts";
import {
  escapeHtml,
  lastLines,
  type RenderedPage,
  renderFailedPage,
  renderLoadingPage,
  renderWaitingPage,
  type ShellFailure,
  type ShellPageName,
  type ShellPageStrings,
  STDERR_LINES,
  shellRoute,
} from "../src/main/shell-pages.ts";
import { shellBridge } from "../src/preload/bridges.ts";

const SHELL = resolve(import.meta.dirname, "../src/shell");

const EN: ShellPageStrings = {
  lang: "en",
  starting: "Starting LAPLACE Eidolon…",
  waiting: "Waiting for LAPLACE Eidolon's server…",
  tryAgain: "Try Again",
  showLogs: "Show Logs",
  quit: "Quit",
  details: "Details",
};

const ZH: ShellPageStrings = {
  lang: "zh-Hans",
  starting: "正在启动 LAPLACE Eidolon…",
  waiting: "正在等待 LAPLACE Eidolon 的服务器…",
  tryAgain: "重试",
  showLogs: "显示日志",
  quit: "退出",
  details: "详情",
};

const FAILURE: ShellFailure = {
  title: "LAPLACE Eidolon Couldn't Start",
  message: "LAPLACE Eidolon's server stopped with exit code 1.",
  stderr: "eidolon: port 7860 is taken by another program; choose one with --port\n",
};

function template(page: ShellPageName, dir = SHELL): string {
  return readFileSync(join(dir, `${page}.html`), "utf8");
}

function render(page: ShellPageName, strings: ShellPageStrings, dir = SHELL): RenderedPage {
  if (page === "failed") return renderFailedPage(template(page, dir), strings, FAILURE);
  if (page === "waiting") return renderWaitingPage(template(page, dir), strings);
  return renderLoadingPage(template(page, dir), strings);
}

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name as string, values.join(" ")];
    }),
  );
}

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const styles = (html: string) =>
  [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(([, css]) => css);
const PAGES: ShellPageName[] = ["loading", "failed", "waiting"];

describe("the shell pages", () => {
  test("fill every placeholder, in either language, and say which it is", () => {
    for (const strings of [EN, ZH]) {
      for (const page of PAGES) {
        const { html } = render(page, strings);
        expect(html, page).not.toContain("{{");
        expect(html, page).toContain(`<html lang="${strings.lang}">`);
      }
      expect(render("loading", strings).html).toContain(escapeHtml(strings.starting));
      expect(render("waiting", strings).html).toContain(escapeHtml(strings.waiting));
      const failed = render("failed", strings).html;
      for (const label of [strings.tryAgain, strings.showLogs, strings.quit, strings.details]) {
        expect(failed).toContain(escapeHtml(label));
      }
    }
  });

  test("each has the strip the window drags by, and nothing but its status or card below it", () => {
    for (const page of PAGES) {
      const { html } = render(page, EN);
      expect(html).toContain('<div class="drag" aria-hidden="true"></div>');
      expect(html.match(/<main>/g)).toHaveLength(1);
    }
    for (const page of ["loading", "waiting"] as const) {
      expect(render(page, EN).html).toMatch(/<p class="status" role="status">[^<]+<\/p>/);
    }
  });

  test("the failure page has a button for each of the shell bridge's calls, and no other", () => {
    const actions = [...render("failed", EN).html.matchAll(/data-action="(\w+)"/g)].map(
      ([, action]) => action,
    );
    const bridge = shellBridge({ send() {} });
    expect(actions.toSorted()).toEqual(Object.keys(bridge).toSorted());
    expect(template("failed")).toContain('<script type="module" src="./failed.ts"></script>');
  });

  test("their scripts load nothing at all: a page has the shell bridge and nothing else", () => {
    const scripts = readdirSync(SHELL).filter((name) => name.endsWith(".ts"));
    expect(scripts).toContain("failed.ts");
    for (const name of scripts) expect([name, scan(join(SHELL, name))]).toEqual([name, []]);
  });

  test("escape what they are given, and fill it in once, so a value's braces stay text", () => {
    const hostile = { ...EN, starting: `<script>alert("x")</script> & 'it' {{lang}}` };
    const { html } = renderLoadingPage(template("loading"), hostile);
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;it&#39; {{lang}}",
    );
    expect(html).not.toContain('<script>alert("x")');
    const failed = renderFailedPage(
      template("failed"),
      { ...EN, lang: 'en" onload="x' },
      { ...FAILURE, title: "<img src=x>", stderr: "</pre><script>x()</script>" },
    ).html;
    expect(failed).toContain('<html lang="en&quot; onload=&quot;x">');
    expect(failed).toContain('<h1 id="title">&lt;img src=x&gt;</h1>');
    expect(failed).toContain(
      '<pre class="output"><code>&lt;/pre&gt;&lt;script&gt;x()&lt;/script&gt;</code></pre>',
    );
  });

  test("a placeholder the strings don't fill is a mistake, not a blank", () => {
    expect(() => renderLoadingPage("<p>{{nope}}</p>", EN)).toThrow("{{nope}}");
    expect(() => renderLoadingPage("<p>{{constructor}}</p>", EN)).toThrow("{{constructor}}");
  });
});

describe("the failure page's output", () => {
  const output = (stderr: string, message = "") =>
    /<pre class="output"><code>([\s\S]*?)<\/code><\/pre>/.exec(
      renderFailedPage(template("failed"), EN, { ...FAILURE, message, stderr }).html,
    )?.[1];

  test("is the last lines of stderr, escaped, without the blank ones it ends with", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1} <${i}>`);
    expect(output(`${lines.join("\r\n")}\r\n\r\n`)).toBe(
      lines.slice(-STDERR_LINES).map(escapeHtml).join("\n"),
    );
    expect(lastLines("a\nb\n\n  \n", 5)).toBe("a\nb");
  });

  test("and the block and the message are empty, so the page hides them, when there are none", () => {
    expect(template("failed")).toMatch(
      /<div class="details">\s*<h2>\{\{details\}\}<\/h2>\s*<pre class="output">/,
    );
    expect(readFileSync(join(SHELL, "shell.css"), "utf8")).toContain(".details:has(code:empty)");
    expect(output("")).toBe("");
    expect(output("\n  \n")).toBe("");
    expect(renderFailedPage(template("failed"), EN, { ...FAILURE, message: "" }).html).toContain(
      '<p class="message"></p>',
    );
  });
});

describe("the pages' CSP", () => {
  test("runs the page's own style by its hash, and no inline script on any page", () => {
    for (const page of PAGES) {
      const { html, csp } = render(page, EN);
      const policy = directives(csp);
      expect(policy.get("default-src")).toBe("'none'");
      expect(policy.get("style-src")).toBe(styles(html).map(sha256).join(" "));
      expect(policy.get("base-uri")).toBe("'none'");
      expect(policy.get("form-action")).toBe("'none'");
      expect(policy.get("frame-ancestors")).toBe("'none'");
      expect(csp).not.toContain("unsafe");
    }
  });

  test("lets only the failure page run a script, its own from the shell host", () => {
    expect(directives(render("failed", EN).csp).get("script-src")).toBe("'self'");
    // At the app's address, 'self' would be the backend.
    expect(directives(render("waiting", EN).csp).has("script-src")).toBe(false);
    expect(directives(render("loading", EN).csp).has("script-src")).toBe(false);
  });
});

test("the shell host serves the loading and failure pages by name, and the assets they link", () => {
  expect(shellRoute("/loading")).toEqual({ page: "loading" });
  expect(shellRoute("/failed")).toEqual({ page: "failed" });
  expect(shellRoute("/assets/failed-KVZZg8dz.js")).toEqual({
    asset: "failed-KVZZg8dz.js",
    type: "text/javascript; charset=utf-8",
  });
  expect(shellRoute("/assets/shell_a-1.css")).toEqual({
    asset: "shell_a-1.css",
    type: "text/css; charset=utf-8",
  });
  for (const pathname of [
    "/",
    "",
    "/waiting",
    "/loading.html",
    "/failed.html",
    "/loading/",
    "/assets/failed.js.map",
    "/assets/../main/index.js",
    "/assets/%2e%2e%2fmain%2findex.js",
    "/assets/nested/x.js",
    "/assets/.js",
    "/assets/x.html",
    "/main/index.js",
  ]) {
    expect([pathname, shellRoute(pathname)]).toEqual([pathname, null]);
  }
});

test("Vite's build carries each page's style inline, so the waiting page needs nothing else", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "eidolon-shell-pages-"));
  try {
    const config = shellPages({ outDir });
    await build({ ...config, logLevel: "silent" });
    for (const page of PAGES) {
      const built = template(page, outDir);
      expect(built).not.toContain("@import");
      expect(styles(built).join("")).toContain("app-region:drag");
      const { csp } = render(page, EN, outDir);
      expect(directives(csp).get("style-src")).toBe(styles(built).map(sha256).join(" "));
    }
    const references = (page: ShellPageName) =>
      [...template(page, outDir).matchAll(/\s(?:src|href)="([^"]*)"/g)].map(([, url]) => url);
    expect(references("waiting")).toEqual([]);
    expect(references("loading")).toEqual([]);
    const [script, ...others] = references("failed");
    expect(others).toEqual([]);
    const route = shellRoute((script as string).replace(/^\./, ""));
    expect(route).toMatchObject({ type: "text/javascript; charset=utf-8" });
    expect(existsSync(join(outDir, "assets", (route as { asset: string }).asset))).toBe(true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
