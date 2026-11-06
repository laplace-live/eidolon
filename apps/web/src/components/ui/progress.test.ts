import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Progress } from "./progress";

test("a screen reader hears how far along it is", () => {
  const html = renderToStaticMarkup(createElement(Progress, { value: 40 }));
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="40"');
  expect(html).toContain('aria-valuetext="40%"');
  expect(html).toContain("translateX(-60%)");
});
