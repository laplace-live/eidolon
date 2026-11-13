import type { BotReadyData, RTVIMessage } from "@pipecat-ai/client-js";
import { RTVIError } from "@pipecat-ai/client-js";
import { chatLineEventOf, isJsonObject } from "../chat/parse.ts";
import type {
  CallSpeaker,
  DeviceErrorReason,
  DeviceErrorType,
  EidolonBotAbout,
  EidolonBotReadyData,
  EidolonErrorMessage,
  EidolonServerMessage,
} from "./types.ts";

// Only root-relative `/api/selfie/<id>` paths are accepted, so an arbitrary URL in a server
// message can never load an external image.
const SELFIE_PATH = /^\/api\/selfie\/[\w-]{1,64}(?:\.[A-Za-z0-9]{1,8})?$/;

/** Verified `/api/selfie/<id>` paths in a server message; empty when it isn't a selfie. */
export function selfiePaths(data: unknown): string[] {
  if (!isJsonObject(data) || data.type !== "selfie" || !Array.isArray(data.urls)) return [];
  return data.urls.filter((url): url is string => typeof url === "string" && SELFIE_PATH.test(url));
}

/** Whose photo a selfie server message says it is, as on a group call; null when absent. */
export function selfiePersona(data: unknown): string | null {
  if (!isJsonObject(data)) return null;
  return typeof data.persona === "string" && data.persona !== "" ? data.persona : null;
}

/** Who a group call's `{ type: "speaker" }` server message names; null for any other message. */
export function speakerOf(data: unknown): CallSpeaker | null {
  if (!isJsonObject(data) || data.type !== "speaker") return null;
  const source = isJsonObject(data.speaker) ? data.speaker : data;
  if (typeof source.persona !== "string" || source.persona === "") return null;
  const name =
    typeof source.name === "string" && source.name.trim() !== "" ? source.name : source.persona;
  return { persona: source.persona, name };
}

export function parseServerMessage(raw: unknown): EidolonServerMessage {
  if (isJsonObject(raw)) {
    if (raw.type === "selfie") {
      return { type: "selfie", urls: selfiePaths(raw), persona: selfiePersona(raw) };
    }
    const line = chatLineEventOf(raw);
    if (line !== null) return { type: "chat-line", event: line };
    const speaker = speakerOf(raw);
    if (speaker !== null) return { type: "speaker", speaker };
  }
  return { type: "unknown", raw };
}

function parseBotAbout(raw: unknown): EidolonBotAbout | null {
  if (!isJsonObject(raw)) return null;
  if (typeof raw.library !== "string" || typeof raw.library_version !== "string") return null;
  return { ...raw, library: raw.library, library_version: raw.library_version };
}

export function parseBotReadyData(data: BotReadyData): EidolonBotReadyData {
  return {
    version: data.version,
    about: parseBotAbout(data.about),
    rawAbout: data.about,
    ...(data.capabilities === undefined ? {} : { capabilities: data.capabilities }),
  };
}

export function parseErrorMessage(message: RTVIMessage): EidolonErrorMessage {
  const raw = message.data;
  let error = "";
  let fatal = false;
  if (isJsonObject(raw)) {
    if (typeof raw.error === "string") error = raw.error;
    else if (typeof raw.message === "string") error = raw.message;
    fatal = raw.fatal === true;
  }
  return {
    id: message.id,
    type: message.type,
    data: { error, fatal },
    rawData: raw,
  };
}

const SOURCE_ERROR_REASONS: Readonly<Record<string, DeviceErrorReason>> = {
  NotAllowedError: "blocked",
  SecurityError: "blocked",
  NotReadableError: "already-in-use",
  NotFoundError: "not-found",
  OverconstrainedError: "invalid-constraints",
};

export function normalizeDeviceErrorReason(
  type: DeviceErrorType,
  details?: unknown,
): DeviceErrorReason {
  switch (type) {
    case "permissions":
      return "blocked";
    case "in-use":
      return "already-in-use";
    case "not-found":
      return "not-found";
    case "constraints":
      return "invalid-constraints";
    case "undefined-mediadevices":
      return "not-supported";
    default: {
      // WavRecorder reports every getUserMedia failure as "unknown" and stashes the DOMException in details.sourceError.
      const cause = isJsonObject(details) ? details.sourceError : undefined;
      const name =
        typeof cause === "object" && cause !== null && "name" in cause ? String(cause.name) : "";
      return SOURCE_ERROR_REASONS[name] ?? "unknown";
    }
  }
}

/** HTTP status carried by a rejected `connect()` error, or undefined when none is attached. */
export function callErrorStatus(error: unknown): number | undefined {
  return error instanceof RTVIError ? error.status : undefined;
}

/** Whether a `connect()` rejection is an HTTP 429 quota refusal on `/api/offer`. */
export function isRateLimitCallError(error: unknown): boolean {
  return callErrorStatus(error) === 429;
}
