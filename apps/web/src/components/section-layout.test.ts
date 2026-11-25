// A section picked far down a long one starts at its own top, measured from the box it scrolls in:
// the frame, which in the desktop app starts 2.75rem down, below the title strip.
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

test("in the desktop app, from the top of the frame below the strip", () => {
  vi.stubGlobal("getComputedStyle", (element: object) => styles.get(element));
  const frame = box(44, null, "auto");
  const column = box(44, frame);
  // 8px of its top hidden above the frame, though 36px down the window.
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
