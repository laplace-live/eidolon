// The image runs `bun install --production`, which installs every workspace's `dependencies`: the
// web app's whole toolchain stays in devDependencies, so none of it ships.
import { expect, test } from "bun:test";
import manifest from "./package.json";

test("the web app has no runtime dependencies", () => {
  expect("dependencies" in manifest).toBe(false);
});

test("every devDependency is an exact pin or a workspace package", () => {
  const ranged = Object.entries(manifest.devDependencies).filter(
    ([, version]) => version !== "workspace:*" && !/^\d+\.\d+\.\d+$/.test(version),
  );
  expect(ranged).toEqual([]);
});

test("it is private and unversioned, so changesets neither versions nor tags it", () => {
  expect(manifest.name).toBe("@eidolon/web");
  expect(manifest.private).toBe(true);
  expect("version" in manifest).toBe(false);
});
