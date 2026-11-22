import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;
// Every test file runs against the repo's persona templates and an empty data home, with Bun's
// toStartWith, toEndWith and toBeNumber.
const setupFiles = [
  resolve(root, "packages/config/test/isolated-home.ts"),
  resolve(root, "packages/config/test/matchers.ts"),
];

export default defineConfig({
  // No .env reaches a test: load-env.ts is the only reader, and tests never import it.
  envDir: false,
  test: {
    // A mock keeps its calls until the test resets it, as under bun:test.
    clearMocks: false,
    // Test files run side by side, one per core, so a test's time includes the others' load: tests
    // that take 1–2 s alone (bash output, 2,000 skill folders, a tokenizer parity sample) passed
    // 5 s with every core busy.
    testTimeout: 20_000,
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "apps/eidolon/pack/**",
      "packages/sdk/pack/**",
    ],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: [
            "apps/{bot,cli,eidolon}/test/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "docs/benchmarks/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
          setupFiles,
        },
      },
      {
        extends: true,
        // The desktop's Electron-free modules: nothing a test imports loads `electron`.
        test: {
          name: "desktop",
          include: ["apps/desktop/test/**/*.test.ts"],
          setupFiles,
        },
      },
      {
        extends: true,
        // The tests stub Lingui's macros themselves, so the plugin that compiles them stays out.
        resolve: { alias: { "@": resolve(root, "apps/web/src") } },
        test: {
          name: "web",
          include: ["apps/web/**/*.test.ts"],
          setupFiles,
        },
      },
    ],
  },
});
