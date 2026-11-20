// The local web app's server, which main.ts runs as a child: the bot plus the app, on loopback.

// The first two imports, in this order, as in main.ts.
import "./environ.ts";
import "../load-env.ts";
import * as access from "@eidolon/access";
import { installHttpDefaults, logger } from "@eidolon/config";
import * as imagegen from "@eidolon/imagegen";
import * as memory from "@eidolon/memory";
import * as retrieval from "@eidolon/retrieval";
import * as runtime from "@eidolon/runtime";
import * as turn from "@eidolon/turn";
import { installUsageLedger } from "@eidolon/usage";
import * as mcp from "../mcp/index.ts";
import { bootLocal } from "./boot.ts";

// As in main.ts: an unhandled rejection exits the process, which would drop a live call.
process.on("unhandledRejection", (reason) => logger.error("Unhandled rejection", reason));
installHttpDefaults();
installUsageLedger();

await bootLocal(process.argv.slice(2), {
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
