import { expect, test } from "vitest";
import { withoutTrailingSlashes } from "../src/url.ts";

test("a URL loses every trailing slash, and nothing else", () => {
  expect(withoutTrailingSlashes("https://api.example/v1///")).toBe("https://api.example/v1");
  expect(withoutTrailingSlashes("https://api.example/v1")).toBe("https://api.example/v1");
  expect(withoutTrailingSlashes("https://api.example//v1/")).toBe("https://api.example//v1");
  expect(withoutTrailingSlashes("///")).toBe("");
  expect(withoutTrailingSlashes("")).toBe("");
});

test("a long run of slashes that doesn't end the URL costs one pass", () => {
  const url = `${"/".repeat(200_000)}x`;
  const started = performance.now();
  expect(withoutTrailingSlashes(url)).toBe(url);
  expect(performance.now() - started).toBeLessThan(500);
});
