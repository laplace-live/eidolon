import "./load-env.ts";
import { installHttpDefaults, logger } from "@eidolon/config";
import { startRelayServer } from "./server.ts";

process.on("unhandledRejection", (reason) => logger.error("Unhandled rejection", reason));
installHttpDefaults();

const server = await startRelayServer();
logger.info(`[relay] Listening on ${server.url} (public URL: ${server.publicUrl})`);

let stopping = false;
const shutdown = () => {
  if (stopping) {
    process.exit(1);
  }
  stopping = true;
  void server
    .stop()
    .catch((error) => logger.error("Relay shutdown failed", error))
    .finally(() => process.exit(0));
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, shutdown);
}
