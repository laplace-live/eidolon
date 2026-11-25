// The image runs `pnpm install --prod`, which installs every workspace's `dependencies`: the
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

test("it is private and versioned, so its releases are tags and never npm packages", () => {
  expect(manifest).toMatchObject({
    name: "laplace-eidolon-desktop",
    productName: "LAPLACE Eidolon",
    private: true,
  });
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
});
