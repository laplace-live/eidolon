// `pnpm build:desktop`: stages the backend for this machine's target in apps/desktop/.stage, then
// builds main, the preload and the shell pages into apps/desktop/dist.
import { build } from "vite";
import { describeStage, hostTarget, stageBackend } from "./stage-backend.ts";
import { mainBundle, preloadBundle, shellPages } from "./vite-common.ts";

console.log(describeStage(await stageBackend(hostTarget())));
for (const config of [mainBundle(), preloadBundle(), shellPages()]) await build(config);
console.log("apps/desktop/dist built");
