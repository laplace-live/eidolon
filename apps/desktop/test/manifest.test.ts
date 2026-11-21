// The image runs `bun install --production`, which installs every workspace's `dependencies`: the
// desktop's whole toolchain stays in devDependencies, so none of it reaches production, and main
// bundles what it runs.
import { expect, test } from "vitest";
import manifest from "../package.json";

test("the desktop app has no runtime dependencies", () => {
  expect("dependencies" in manifest).toBe(false);
});

test("every devDependency is an exact pin or a workspace package", () => {
  const ranged = Object.entries(manifest.devDependencies).filter(
    ([, version]) => version !== "workspace:*" && !/^\d+\.\d+\.\d+$/.test(version),
  );
  expect(ranged).toEqual([]);
});

test("it is private, and unversioned until it has releases, so no publish tags it", () => {
  expect(manifest).toMatchObject({
    name: "laplace-eidolon-desktop",
    productName: "Eidolon",
    private: true,
  });
  expect("version" in manifest).toBe(false);
});
