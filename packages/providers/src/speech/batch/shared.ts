// What every batch speech request shares: the account's API base, one fetch that turns an error
// status into a ProviderHttpError, and the spoken language a call would use.
import { envOptional } from "@eidolon/config";
import { httpError } from "../../http/errors.ts";
import { ProviderConfigError, type Selection } from "../../resolve.ts";

export interface FetchOptions {
  readonly signal?: AbortSignal;
  /** For tests. */
  readonly fetch?: typeof fetch;
}

export function baseOf(selection: Selection): string {
  if (selection.baseUrl === undefined) {
    throw new ProviderConfigError(`${selection.account.name} has no API base`);
  }
  return selection.baseUrl.replace(/\/+$/, "");
}

/** The answer to `init` at `url`, or the provider's error. */
export async function send(
  selection: Selection,
  url: string,
  init: RequestInit,
  options: FetchOptions,
): Promise<Response> {
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    ...init,
    signal: options.signal ?? null,
  });
  if (!response.ok) throw await httpError(selection.provider.name, response);
  return response;
}

/**
 * The language viewers speak with her, as a call's STT and TTS take it: STT_LANGUAGE, else her
 * videos' language, else Mandarin; null for `none`, which lets the provider detect it.
 */
export function spokenLanguage(): string | null {
  const language = (
    envOptional("STT_LANGUAGE") ??
    envOptional("TRANSCRIBE_LANGUAGE") ??
    "zh"
  ).trim();
  return language.toLowerCase() === "none" ? null : language;
}

/** `audio/webm;codecs=opus` as `audio/webm`. */
export function baseMime(mime: string): string {
  return (mime.split(";")[0] as string).trim().toLowerCase();
}

const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["mpeg", "mp3"],
  ["mp4", "m4a"],
]);

/** A file name for an upload, whose extension OpenAI reads the format from. */
export function fileName(mime: string): string {
  const subtype = baseMime(mime).split("/")[1] ?? "";
  return `voice.${EXTENSIONS.get(subtype) ?? (subtype.replace(/^x-/, "") || "bin")}`;
}
