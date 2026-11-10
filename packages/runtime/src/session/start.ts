// The lines a call logs as it starts, on either voice engine; no pipedog, so src/native shares it.
import type { AllowedOffer } from "@eidolon/access";
import { cpLen, isJsonObject, logger, pyRepr } from "@eidolon/config";

/** `requestData` as the log may carry it: a chat window, the viewer's conversation, by size alone. */
function loggedRequestData(requestData: AllowedOffer["requestData"]): unknown {
  if (requestData === null || !("chat" in requestData)) return requestData;
  const events = isJsonObject(requestData.chat) ? requestData.chat.events : undefined;
  const chat = Array.isArray(events) ? `<chat: ${events.length} events>` : "<chat: not a window>";
  return { ...requestData, chat };
}

/** `[bot] Session start …` and `Starting bot`, which the local app's status and the e2e notes read. */
export function logSessionStart(admission: Pick<AllowedOffer, "token" | "requestData">): void {
  // Logged either way: the "anonymous everywhere" failure mode is
  // otherwise silent, and this makes it one grep.
  if (admission.token) {
    logger.info(`[bot] Session start with loginSyncToken (len=${cpLen(admission.token)})`);
  } else {
    const body = pyRepr(loggedRequestData(admission.requestData));
    logger.info(`[bot] Session start without loginSyncToken; runner_args.body=${body}`);
  }
  logger.info("Starting bot");
}
