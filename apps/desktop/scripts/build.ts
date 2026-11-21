// Builds main, the preload and the shell pages into apps/desktop/dist (`bun run build:desktop`).
import { build } from "vite";
import { mainBundle, preloadBundle, shellPages } from "./vite-common.ts";

for (const config of [mainBundle(), preloadBundle(), shellPages()]) await build(config);
console.log("apps/desktop/dist built");
