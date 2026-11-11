// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/processors/frameworks/rtvi/{models,processor}.ts@ce8f8bc
//
// The rtvi-ai envelope on a call's data channel: building outbound messages, and reading inbound
// ones with the error texts pipedog's RTVIProcessor answers them with.

export const RTVI_LABEL = "rtvi-ai";
/** Clients of the same major accept it: client-js 1.16.0 speaks 2.3.0. */
export const PROTOCOL_VERSION = "2.2.0";

export type RtviMessage = {
  readonly label: typeof RTVI_LABEL;
  readonly type: string;
  readonly id?: string;
  readonly data?: Readonly<Record<string, unknown>>;
};

/** pipedog's `modelDump({ excludeNone })` key order: label, type, then `id` and `data` when set. */
export function rtviMessage(
  type: string,
  data?: Readonly<Record<string, unknown>>,
  id?: string,
): RtviMessage {
  return {
    label: RTVI_LABEL,
    type,
    ...(id === undefined ? {} : { id }),
    ...(data === undefined ? {} : { data }),
  };
}

export type RtviInbound =
  | {
      readonly type: "client-ready";
      readonly id: string;
      /** Answered with `error-response` before `bot-ready`; the call goes on either way. */
      readonly versionError: string | null;
    }
  | {
      readonly type: "send-text";
      readonly id: string;
      readonly content: string;
      readonly runImmediately: boolean;
      readonly audioResponse: boolean;
    }
  | { readonly type: "disconnect-bot"; readonly id: string }
  | {
      readonly type: "client-message";
      readonly id: string;
      readonly t: string;
      readonly d: unknown;
    }
  /** An unsupported type or invalid data: answered with `error-response`. */
  | { readonly type: "rejected"; readonly id: string; readonly error: string }
  /** An rtvi-ai message without a valid envelope: answered with `error`. */
  | { readonly type: "malformed"; readonly error: string }
  /** Not RTVI at all: pipedog logs it and drops it. */
  | { readonly type: "foreign" };

type Fields = Record<string, unknown>;
type Issue = { readonly loc: readonly string[]; readonly msg: string };

function isDict(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** pydantic's ValidationError text, as pipedog's models format it. */
function validationText(title: string, issues: readonly Issue[]): string {
  const lines = issues.map((i) => `${i.loc.join(".")}\n  ${i.msg}`);
  const plural = issues.length === 1 ? "" : "s";
  return `${issues.length} validation error${plural} for ${title}\n${lines.join("\n")}`;
}

function requiredString(data: Fields, key: string, issues: Issue[]): void {
  const value = data[key];
  if (value === undefined) {
    issues.push({ loc: [key], msg: "Field required" });
  } else if (typeof value !== "string") {
    issues.push({ loc: [key], msg: "Input should be a valid string" });
  }
}

function booleanOr(data: Fields, key: string, issues: Issue[], loc: readonly string[]): boolean {
  const value = data[key];
  if (value === undefined) return true;
  if (typeof value !== "boolean") {
    issues.push({ loc: [...loc, key], msg: "Input should be a valid boolean" });
    return true;
  }
  return value;
}

function notADict(title: string): string {
  return validationText(title, [
    { loc: [], msg: `Input should be a valid dictionary or instance of ${title}` },
  ]);
}

/** Python's int() on a version part: an optional sign and digits, surrounding whitespace allowed. */
function versionPart(part: string): number | null {
  return /^\s*[+-]?\d+\s*$/.test(part) ? Number.parseInt(part, 10) : null;
}

/** `_handleClientReady`'s check, except that only major 2 is served: pipedog also served 1.x. */
function versionError(data: Fields | null): string | null {
  const version = data?.version;
  let error: string | null = null;
  if (typeof version !== "string" || version === "") {
    error = "Client version unknown.";
  } else {
    const parts = version.split(".").map(versionPart);
    if (parts.length !== 3 || parts.includes(null)) {
      error = `Invalid client version format (${version}).`;
    } else if (parts[0] !== versionPart(PROTOCOL_VERSION.split(".")[0] as string)) {
      error = `RTVI version ${version} is not compatible with server protocol ${PROTOCOL_VERSION}.`;
    }
  }
  return error === null ? null : `${error} Compatibility issues may occur.`;
}

function readSendText(id: string, data: Fields | null): RtviInbound {
  const title = "SendTextData";
  if (data === null) return { type: "rejected", id, error: `Invalid message: ${notADict(title)}` };
  const issues: Issue[] = [];
  requiredString(data, "content", issues);
  let runImmediately = true;
  let audioResponse = true;
  const options = data.options;
  if (isDict(options)) {
    runImmediately = booleanOr(options, "run_immediately", issues, ["options"]);
    audioResponse = booleanOr(options, "audio_response", issues, ["options"]);
  } else if (options !== undefined && options !== null) {
    issues.push({
      loc: ["options"],
      msg: "Input should be a valid dictionary or instance of SendTextOptions",
    });
  }
  if (issues.length > 0) {
    return { type: "rejected", id, error: `Invalid message: ${validationText(title, issues)}` };
  }
  return { type: "send-text", id, content: data.content as string, runImmediately, audioResponse };
}

function readClientMessage(id: string, data: Fields | null): RtviInbound {
  const title = "RawClientMessageData";
  if (data === null) return { type: "rejected", id, error: `Invalid message: ${notADict(title)}` };
  const issues: Issue[] = [];
  requiredString(data, "t", issues);
  if (issues.length > 0) {
    return { type: "rejected", id, error: `Invalid message: ${validationText(title, issues)}` };
  }
  return { type: "client-message", id, t: data.t as string, d: data.d ?? null };
}

/** Reads one app message from the data channel. */
export function readRtvi(message: unknown): RtviInbound {
  if (!isDict(message) || message.label !== RTVI_LABEL) return { type: "foreign" };
  const issues: Issue[] = [];
  requiredString(message, "type", issues);
  requiredString(message, "id", issues);
  const raw = message.data;
  if (raw !== undefined && raw !== null && !isDict(raw)) {
    issues.push({ loc: ["data"], msg: "Input should be a valid dictionary" });
  }
  if (issues.length > 0) {
    const text = validationText("Message", issues);
    return { type: "malformed", error: `Invalid RTVI transport message: ${text}` };
  }
  const type = message.type as string;
  const id = message.id as string;
  const data = isDict(raw) ? raw : null;
  switch (type) {
    case "client-ready":
      return { type, id, versionError: versionError(data) };
    case "send-text":
      return readSendText(id, data);
    case "disconnect-bot":
      return { type, id };
    case "client-message":
      return readClientMessage(id, data);
    default:
      return { type: "rejected", id, error: `Unsupported type ${type}` };
  }
}
