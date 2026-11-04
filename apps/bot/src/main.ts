// The bot's entry point, run by `bun run dev`/`start` and the Docker CMD; tests never import it.

// Must stay the first import. ESM evaluates every import before this module's body, so a .env load
// in the body would run after the packages were evaluated, and anything they read at import would
// keep its fallback even when .env sets a value.
import "./load-env.ts";
import * as access from "@eidolon/access";
import { logger } from "@eidolon/config";
import * as imagegen from "@eidolon/imagegen";
import * as memory from "@eidolon/memory";
import * as retrieval from "@eidolon/retrieval";
import * as runtime from "@eidolon/runtime";
import * as turn from "@eidolon/turn";
import { parseBotArgs } from "./args.ts";
import * as mcp from "./mcp/index.ts";
import { shutdownHandler, startBotServer } from "./server.ts";

// Bun exits on an unhandled rejection, so one stray promise would drop every live call; Python's
// event loop only logs it.
process.on("unhandledRejection", (reason) => logger.error("Unhandled rejection", reason));

const args = parseBotArgs(Bun.argv.slice(2));
const bot = await startBotServer(args, {
  access,
  imagegen,
  memory,
  retrieval,
  runtime,
  turn,
  mcp,
}).catch((error: unknown) => {
  logger.critical("Bot failed to start", error);
  process.exit(1);
});

// As PID 1, bun ignores SIGTERM unless a handler is installed: docker stop waited out its timeout
// and SIGKILLed it.
const onSignal = shutdownHandler(bot, (code) => process.exit(code));
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);
