import { jsonResponse } from "../responses.ts";

/** The chat endpoint's refusal, its routes' and a chat call's offer's alike. */
export function chatError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } }, { "cache-control": "no-store" });
}
