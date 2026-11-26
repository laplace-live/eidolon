// Minimal Node DOM container for driving React 19 `createRoot` + `act` in Vitest tests without
// pulling a browser or jsdom dependency into `apps/web`.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

interface FakeNode {
  readonly nodeType: number;
  readonly tagName?: string;
  readonly childNodes: FakeNode[];
  readonly attrs: Map<string, string>;
  parentNode: FakeNode | null;
  nodeValue: string;
  data?: string;
  textContent: string;
  innerHTML: string;
  outerHTML: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createFakeDom() {
  class FakeIFrameElement {}

  const makeElement = (tag: string): FakeNode => {
    const children: FakeNode[] = [];
    const attrs = new Map<string, string>();
    const node: FakeNode & Record<string, unknown> = {
      nodeType: 1,
      nodeName: tag,
      tagName: tag.toUpperCase(),
      ownerDocument: doc,
      childNodes: children,
      attrs,
      parentNode: null,
      style: { setProperty() {}, removeProperty() {} },
      nodeValue: "",
      set className(value: string) {
        attrs.set("class", value);
      },
      get className() {
        return attrs.get("class") ?? "";
      },
      set textContent(value: string) {
        children.length = 0;
        if (value) children.push(doc.createTextNode(String(value)));
      },
      get textContent() {
        return children.map((c) => (c.nodeType === 3 ? (c.data ?? "") : c.textContent)).join("");
      },
      get innerHTML() {
        return children.map((c) => c.outerHTML).join("");
      },
      set innerHTML(_value: string) {
        children.length = 0;
      },
      get outerHTML() {
        const attrText = [...attrs.entries()].map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join("");
        return `<${tag}${attrText}>${node.innerHTML}</${tag}>`;
      },
      appendChild(child: FakeNode) {
        child.parentNode = node;
        children.push(child);
        return child;
      },
      insertBefore(child: FakeNode, ref: FakeNode | null) {
        child.parentNode = node;
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
      setAttribute(name: string, value: string) {
        attrs.set(name, String(value));
      },
      removeAttribute(name: string) {
        attrs.delete(name);
      },
    };
    return node;
  };

  const doc = {
    createElement: (tag: string) => makeElement(tag),
    createElementNS: (_ns: string, tag: string) => makeElement(tag),
    createTextNode: (text: string): FakeNode => {
      const value = String(text);
      return {
        nodeType: 3,
        attrs: new Map(),
        nodeValue: value,
        data: value,
        childNodes: [],
        parentNode: null,
        textContent: value,
        innerHTML: escapeHtml(value),
        outerHTML: escapeHtml(value),
      };
    },
    createComment: (text: string): FakeNode => ({
      nodeType: 8,
      attrs: new Map(),
      nodeValue: String(text),
      data: String(text),
      childNodes: [],
      parentNode: null,
      textContent: "",
      innerHTML: "",
      outerHTML: "",
    }),
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    defaultView: { HTMLIFrameElement: FakeIFrameElement },
    activeElement: null,
  };

  return {
    container: makeElement("div"),
    doc,
    win: {
      event: undefined,
      document: doc,
      navigator: {},
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener() {},
      removeEventListener() {},
    },
    FakeIFrameElement,
  };
}

export interface MountedRoot {
  readonly container: { readonly textContent: string; readonly innerHTML: string };
  readonly act: (fn: () => void | Promise<void>) => Promise<void>;
  readonly render: (node: ReactNode) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

/** Mounts React 19 in Node for boundary/effect tests; call `unmount()` in `afterEach`. */
export async function mountFakeDom(initial: ReactNode): Promise<MountedRoot> {
  const dom = createFakeDom();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLIFrameElement", dom.FakeIFrameElement);
  vi.stubGlobal("window", dom.win);
  vi.stubGlobal("document", dom.doc);

  let root: Root | null = createRoot(dom.container as unknown as Element, {
    onCaughtError: () => {},
  });

  await act(async () => {
    root?.render(createElement("div", null, initial));
  });

  return {
    container: dom.container,
    act: async (fn: () => void | Promise<void>) => {
      await act(async () => {
        await fn();
      });
    },
    render: async (next: ReactNode) => {
      await act(async () => {
        root?.render(createElement("div", null, next));
      });
    },
    unmount: async () => {
      if (root !== null) {
        const current = root;
        root = null;
        await act(async () => current.unmount());
      }
      vi.unstubAllGlobals();
    },
  };
}
