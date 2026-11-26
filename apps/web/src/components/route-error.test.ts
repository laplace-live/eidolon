// Verifies RouteBoundary catches render failures and resets on pathname change, query string
// change, and same-URL navigation without forcing parent routes to subscribe to location.
import { createElement, type FunctionComponent } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Router, type RouterOptions, useLocation, useSearch } from "wouter";
import { createBrowserHistory, HistoryControllerProvider } from "@/lib/navigation";
import { type MountedRoot, mountFakeDom } from "@/test/fake-dom";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { RouteBoundary } = await import("./route-error");

describe("RouteBoundary", () => {
  let mounted: MountedRoot | null = null;

  afterEach(async () => {
    if (mounted !== null) {
      const current = mounted;
      mounted = null;
      await current.unmount();
    }
  });

  test("resets caught errors on pathname change, search change, and same-URL navigation", async () => {
    const history = createBrowserHistory(null);
    let broken = true;

    function View() {
      const [path] = useLocation();
      const search = useSearch();
      if (broken) throw new Error("boom");
      return createElement("p", null, `ok:${path}?${search}`);
    }

    const tree = createElement(
      HistoryControllerProvider,
      { value: history },
      createElement(
        Router as FunctionComponent<RouterOptions>,
        { hook: history.hook, searchHook: history.searchHook },
        createElement(
          RouteBoundary,
          { fallback: (err) => createElement("span", null, (err as Error).message) },
          createElement(View),
        ),
      ),
    );

    mounted = await mountFakeDom(tree);
    expect(mounted.container.textContent).toBe("boom");

    // Changing only the query string clears the caught error.
    broken = false;
    await mounted.act(() => history.navigate("/?tab=b"));
    expect(mounted.container.textContent).toBe("ok:/?tab=b");

    // Re-error at /settings, then navigate to another pathname.
    broken = true;
    await mounted.act(() => history.navigate("/settings"));
    expect(mounted.container.textContent).toBe("boom");
    broken = false;
    await mounted.act(() => history.navigate("/jobs"));
    expect(mounted.container.textContent).toBe("ok:/jobs?");

    // Re-error at /same, then follow the same URL again (e.g. clicking Back to Home on /).
    broken = true;
    await mounted.act(() => history.navigate("/same"));
    expect(mounted.container.textContent).toBe("boom");
    broken = false;
    await mounted.act(() => history.navigate("/same"));
    expect(mounted.container.textContent).toBe("ok:/same?");

    history.dispose();
  });
});
