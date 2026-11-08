import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-Hans"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}",
      include: ["src"],
      exclude: ["**/node_modules/**", "**/*.test.ts"],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
