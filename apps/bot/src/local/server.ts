// The local web app's server, which main.ts runs as a child: the bot plus the app, on loopback.

// Must stay the first import, for the reason apps/bot/src/main.ts gives.
import "../load-env.ts";
import * as access from "@eidolon/access";
import { logger } from "@eidolon/config";
import * as imagegen from "@eidolon/imagegen";
import * as memory from "@eidolon/memory";
import * as retrieval from "@eidolon/retrieval";
import * as runtime from "@eidolon/runtime";
import * as turn from "@eidolon/turn";
import { installUsageLedger } from "@eidolon/usage";
import * as mcp from "../mcp/index.ts";
import { bootLocal } from "./boot.ts";

// As in main.ts: Bun exits on an unhandled rejection, which would drop a live call.
process.on("unhandledRejection", (reason) => logger.error("Unhandled rejection", reason));
installUsageLedger();

await bootLocal(Bun.argv.slice(2), {
  access,
  imagegen,
  memory,
  retrieval,
  runtime,
  turn,
  mcp,
}).catch((error: unknown) => {
  logger.critical("Eidolon failed to start", error);
  process.exit(1);
});
