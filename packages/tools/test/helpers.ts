import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { consoleSink, type LogRecord, logger, pyJsonDumps } from "@eidolon/config";
import type {
  ConversationContext,
  LlmTool,
  ToolEffects,
  ToolResult,
  ToolSchema,
} from "@eidolon/core";

const savedEnv = new Map<string, string | undefined>();

/** Set, or with `undefined` unset, an env var until `restoreEnv`. */
export function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function restoreEnv(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

const SELFIE_ENV = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_APP_NAME",
  "OPENROUTER_APP_URL",
  "PERSONA_TIMEZONE",
  "SELFIE_ASPECT_RATIO",
  "SELFIE_MODEL",
  "SELFIE_QUALITY",
  "SELFIE_REFERENCE_IMAGES",
  "SELFIE_TIMEOUT_SECONDS",
  "SELFIE_TTL_SECONDS",
];

/** Every variable the selfie path reads, unset. */
export function clearSelfieEnv(): void {
  for (const name of SELFIE_ENV) setEnv(name, undefined);
}

/** Route log records into the returned array until `restoreLogs`. */
export function captureLogs(): LogRecord[] {
  const records: LogRecord[] = [];
  logger.setSink((record) => {
    records.push(record);
  });
  return records;
}

export function restoreLogs(): void {
  logger.setSink(consoleSink);
}

export function logLines(records: readonly LogRecord[]): string[] {
  return records.map((record) => `${record.level} ${record.message}`);
}

const tempDirs: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-tools-"));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Write `files` (relative path → bytes or text) under `root`, a new temp directory by default. */
export function tempTree(
  files: Readonly<Record<string, Uint8Array | string>>,
  root: string = tempDir(),
): string {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

/** Distinct bytes per file, so a test can tell which reference was sent. */
export function bytesOf(label: string): Uint8Array {
  return new TextEncoder().encode(`\x89PNG ${label}`);
}

export function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${bytes.toBase64()}`;
}

/** The OpenAI tool list the Python adapter sends, serialized as `json.dumps(ensure_ascii=False)`. */
export function wire(schema: ToolSchema): string {
  return pyJsonDumps(
    [
      {
        type: "function",
        function: {
          name: schema.name,
          description: schema.description,
          parameters: { type: "object", properties: schema.properties, required: schema.required },
        },
      },
    ],
    { ensureAscii: false },
  );
}

export interface FetchCall {
  readonly url: string;
  readonly init: BunFetchRequestInit;
  readonly payload: Record<string, unknown>;
}

/** A fetch that records each request and answers with `respond`. */
export function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init: BunFetchRequestInit = {}) => {
    const call = { url: String(input), init, payload: JSON.parse(String(init.body)) };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class CancelledError extends Error {
  override name = "CancelledError";
}

const context: ConversationContext = {
  getMessages: () => [],
  setMessages: () => {},
  setHiddenTools: () => {},
};

/**
 * Run `tool` as runtime does, recording effects and the result in order. Each effect settles a
 * tick later, so a tool that forgot to await one would record its result first.
 */
export async function invoke(
  tool: LlmTool,
  args: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ events: unknown[][]; result: ToolResult }> {
  const events: unknown[][] = [];
  const effects: ToolEffects = {
    async switchVoice(referenceId) {
      await Bun.sleep(1);
      events.push(["push", "TTSUpdateSettingsFrame", referenceId]);
    },
    async sendServerMessage(data) {
      await Bun.sleep(1);
      events.push(["push", "RTVIServerMessageFrame", data]);
    },
  };
  const result = await tool.run({ arguments: args, context, signal }, effects);
  events.push(["result", result]);
  return { events, result };
}
