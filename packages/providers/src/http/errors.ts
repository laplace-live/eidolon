// A provider's error, with its HTTP status and the message its body gives.
import { isPlainObject } from "@eidolon/config";

export class ProviderHttpError extends Error {
  override name = "ProviderHttpError";
  readonly status: number;
  readonly provider: string;

  constructor(provider: string, status: number, message: string) {
    super(`${provider} answered ${status}: ${message}`);
    this.status = status;
    this.provider = provider;
  }
}

/** The message in an error body: OpenAI's `{error: {message}}`, Anthropic's, or the text. */
export function errorMessageOf(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text.trim().slice(0, 500) || "no body";
  }
  const error = isPlainObject(body) ? body.error : undefined;
  if (isPlainObject(error) && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  if (isPlainObject(body) && typeof body.message === "string") return body.message;
  return text.trim().slice(0, 500);
}

export async function httpError(provider: string, response: Response): Promise<ProviderHttpError> {
  const text = await response.text().catch(() => "");
  return new ProviderHttpError(provider, response.status, errorMessageOf(text));
}
