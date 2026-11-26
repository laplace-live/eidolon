// Verifies RouteBoundary catches render failures and resets on pathname change, query string
// change, and same-URL navigation without forcing parent routes to subscribe to location.
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Router, type RouterOptions, useLocation, useSearch } from "wouter";
import { createBrowserHistory, HistoryControllerProvider } from "@/lib/navigation";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { RouteBoundary } = await import("./route-error");

interface FakeNode {
  readonly nodeType: number;
  readonly childNodes: FakeNode[];
  parentNode: FakeNode | null;
  nodeValue: string;
  data?: string;
  textContent: string;
}

function createFakeDom() {
  class FakeIFrameElement {}
  const makeNode = (tag: string): FakeNode => {
    const children: FakeNode[] = [];
    return {
      nodeType: 1,
      nodeName: tag,
      tagName: tag.toUpperCase(),
      ownerDocument: doc,
      childNodes: children,
      parentNode: null,
      style: {},
      nodeValue: "",
      set textContent(value: string) {
        children.length = 0;
        if (value) children.push(doc.createTextNode(String(value)));
      },
      get textContent() {
        return children
          .map((child) => (child.nodeType === 3 ? (child.data ?? "") : child.textContent))
          .join("");
      },
      appendChild(child: FakeNode) {
        child.parentNode = this;
        children.push(child);
        return child;
      },
      insertBefore(child: FakeNode, ref: FakeNode | null) {
        child.parentNode = this;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, child);
        else children.push(child);
        return child;
      },
      removeChild(child: FakeNode) {
        const idx = children.indexOf(child);
        if (idx >= 0) children.splice(idx, 1);
        child.parentNode = null;
        return child;
      },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
    } as FakeNode;
  };
  const doc = {
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    createTextNode: (text: string): FakeNode => ({
      nodeType: 3,
      nodeValue: String(text),
      data: String(text),
      childNodes: [],
      parentNode: null,
      textContent: String(text),
    }),
    createComment: (text: string): FakeNode => ({
      nodeType: 8,
      nodeValue: String(text),
      data: String(text),
      childNodes: [],
      parentNode: null,
      textContent: "",
    }),
    addEventListener() {},
    removeEventListener() {},
    defaultView: { HTMLIFrameElement: FakeIFrameElement },
    activeElement: null,
  };
  return {
    container: makeNode("div"),
    doc,
    win: {
      event: undefined,
      document: doc,
      navigator: {},
      addEventListener() {},
      removeEventListener() {},
    },
    FakeIFrameElement,
  };
}

describe("RouteBoundary", () => {
  let root: Root | null = null;

  afterEach(async () => {
    if (root !== null) {
      const current = root;
      root = null;
      await act(async () => current.unmount());
    }
    vi.unstubAllGlobals();
  });

  test("resets caught errors on pathname change, search change, and same-URL navigation", async () => {
    const dom = createFakeDom();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("HTMLIFrameElement", dom.FakeIFrameElement);
    vi.stubGlobal("window", dom.win);
    vi.stubGlobal("document", dom.doc);

    const history = createBrowserHistory(null);
    let broken = true;

    function View() {
      const [path] = useLocation();
      const search = useSearch();
      if (broken) throw new Error("boom");
      return createElement("p", null, `ok:${path}?${search}`);
    }

    root = createRoot(dom.container as unknown as Element, {
      onCaughtError: () => {},
    });

    await act(async () => {
      root?.render(
        createElement(
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
        ),
      );
    });
    expect(dom.container.textContent).toBe("boom");

    // Changing only the query string clears the caught error.
    broken = false;
    await act(async () => history.navigate("/?tab=b"));
    expect(dom.container.textContent).toBe("ok:/?tab=b");

    // Re-error at /settings, then navigate to another pathname.
    broken = true;
    await act(async () => history.navigate("/settings"));
    expect(dom.container.textContent).toBe("boom");
    broken = false;
    await act(async () => history.navigate("/jobs"));
    expect(dom.container.textContent).toBe("ok:/jobs?");

    // Re-error at /same, then follow the same URL again (e.g. clicking Back to Home on /).
    broken = true;
    await act(async () => history.navigate("/same"));
    expect(dom.container.textContent).toBe("boom");
    broken = false;
    await act(async () => history.navigate("/same"));
    expect(dom.container.textContent).toBe("ok:/same?");

    history.dispose();
  });
});
