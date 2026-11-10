// Soniox's async files API, for one short clip: upload, create, poll, fetch, delete. Its own client,
// since @eidolon/ingest's, built for hours of audio, must never reach the bot image.
import { abortableSleep, errorText, isPlainObject, logger } from "@eidolon/config";
import { ProviderHttpError } from "../../http/errors.ts";
import type { Selection } from "../../resolve.ts";
import { baseMime, baseOf, type FetchOptions, fileName, send } from "./shared.ts";

export interface SonioxOptions extends FetchOptions {
  /** For tests: the wait between polls. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const POLL_MS = 500;
/** How long the deletes may take once the transcript is in, or the request has failed. */
const CLEANUP_TIMEOUT_MS = 10_000;

async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return isPlainObject(parsed) ? parsed : {};
}

export async function sonioxTranscribe(
  selection: Selection & { readonly apiKey: string },
  audio: { readonly bytes: Uint8Array; readonly mime: string },
  model: string,
  language: string | null,
  options: SonioxOptions,
): Promise<{ text: string; durationMs: number | null }> {
  const base = baseOf(selection);
  const auth = { Authorization: `Bearer ${selection.apiKey}` };
  const get = async (path: string) =>
    body(await send(selection, `${base}${path}`, { method: "GET", headers: auth }, options));
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio.bytes as Uint8Array<ArrayBuffer>], { type: baseMime(audio.mime) }),
    fileName(audio.mime),
  );
  const file = await body(
    await send(selection, `${base}/files`, { headers: auth, body: form }, options),
  );
  let job: string | null = null;
  try {
    let state = await body(
      await send(
        selection,
        `${base}/transcriptions`,
        {
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            file_id: file.id,
            ...(language === null ? {} : { language_hints: [language] }),
          }),
        },
        options,
      ),
    );
    job = String(state.id);
    while (state.status !== "completed") {
      if (state.status === "error") {
        throw new ProviderHttpError(
          selection.provider.name,
          200,
          `${String(state.error_type ?? "error")}: ${String(state.error_message ?? "no message")}`,
        );
      }
      await (options.sleep ?? abortableSleep)(POLL_MS, options.signal);
      state = await get(`/transcriptions/${job}`);
    }
    const transcript = await get(`/transcriptions/${job}/transcript`);
    const ms = state.audio_duration_ms;
    return {
      text: typeof transcript.text === "string" ? transcript.text : "",
      durationMs: typeof ms === "number" && ms > 0 ? ms : null,
    };
  } finally {
    // Without the caller's signal, so a clip it abandoned is still deleted.
    const cleanup = { ...options, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) };
    const paths = [...(job === null ? [] : [`/transcriptions/${job}`]), `/files/${file.id}`];
    for (const path of paths) {
      try {
        await send(selection, `${base}${path}`, { method: "DELETE", headers: auth }, cleanup);
      } catch (error) {
        if (!(error instanceof ProviderHttpError && error.status === 404)) {
          logger.warning(`Soniox kept ${path}: ${errorText(error)}`);
        }
      }
    }
  }
}
