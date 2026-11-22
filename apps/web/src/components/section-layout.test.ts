// A section picked far down a long one starts at its own top, measured from the box it scrolls in:
// a browser's frame, or in the desktop app the page's own box, 3.5rem down below MobileBar.
import { afterEach, expect, test, vi } from "vitest";
import { scrolledPast } from "./section-layout";

const styles = new Map<object, { readonly overflowY: string; readonly scrollMarginTop: string }>();

function box(top: number, parent: Element | null, overflowY = "visible"): Element {
  const element = { parentElement: parent, getBoundingClientRect: () => ({ top }) };
  styles.set(element, { overflowY, scrollMarginTop: "24px" });
  return element as unknown as Element;
}

afterEach(() => {
  styles.clear();
  vi.unstubAllGlobals();
});

test("in the desktop app, from the top of the page's box below the bar", () => {
  vi.stubGlobal("getComputedStyle", (element: object) => styles.get(element));
  const frame = box(0, null, "auto");
  const page = box(56, frame, "auto");
  const column = box(56, page);
  // 20px of its top hidden above the page's box, though 36px down the window.
  expect(scrolledPast(box(36, column))).toBe(true);
  expect(scrolledPast(box(90, column))).toBe(false);
});

test("in a browser, from the top of the frame", () => {
  vi.stubGlobal("getComputedStyle", (element: object) => styles.get(element));
  const frame = box(0, null, "auto");
  const page = box(0, frame);
  expect(scrolledPast(box(36, page))).toBe(false);
  expect(scrolledPast(box(10, page))).toBe(true);
});
