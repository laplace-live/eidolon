// The admin API at /api/local, typed by its wire types in apps/bot/src/local/api.ts, which the SPA
// reaches only through this module. Calls are same-origin with the session cookie and its proof; a
// failure is an ApiError whose `code` the UI shows as t(errorKey(error)), keeping `message` as
// detail only.
import type { ErrorCode, LocalApi, Raw } from "../../../bot/src/local/api.ts";
import { proofHeaders } from "./proof";

export type * from "../../../bot/src/local/api.ts";

/** Codes the client gives failures that never reached the API's {error: {code}} body. */
export const CLIENT_ERROR_CODES = ["unreachable", "bad-response"] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export class ApiError extends Error {
  override readonly name = "ApiError";
  /** 0 when no response arrived. */
  readonly status: number;
  readonly code: ErrorCode | ClientErrorCode;
  /** A 5xx's: names the server's log line that says what went wrong. */
  readonly id: string | null;

  constructor(
    status: number,
    code: ErrorCode | ClientErrorCode,
    message: string,
    id: string | null = null,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.id = id;
  }
}

/** `error` as an ApiError: one the API answered, else a request that never reached it. */
export function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, "unreachable", String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ApiError a failed response's {error: {code, message, id?}} body describes. */
export async function errorFrom(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  return new ApiError(
    response.status,
    typeof error.code === "string" ? (error.code as ErrorCode) : "bad-response",
    typeof error.message === "string" ? error.message : `HTTP ${response.status}`,
    typeof error.id === "string" ? error.id : null,
  );
}

/** The locale key that names an error for the viewer. */
export function errorKey(error: unknown): string {
  return `errors.${error instanceof ApiError ? error.code : "unknown"}`;
}

/** The server's English for an error, with the id of its log line when it has one. */
export function errorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return error instanceof ApiError && error.id !== null
    ? `${error.message} (error ${error.id})`
    : error.message;
}

export type Route = keyof LocalApi;
type Spec<R extends Route> = LocalApi[R];

type ParamName<S extends string> = S extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamName<Rest>
  : S extends `${string}:${infer Name}`
    ? Name
    : never;

/** What a route takes: its `:name` segments, its query and its body, each only when it has one. */
export type Input<R extends Route> = ([ParamName<R>] extends [never]
  ? { readonly params?: undefined }
  : { readonly params: Readonly<Record<ParamName<R>, string>> }) &
  (Spec<R>["query"] extends undefined
    ? { readonly query?: undefined }
    : { readonly query?: Spec<R>["query"] }) &
  (Spec<R>["body"] extends undefined
    ? { readonly body?: undefined }
    : { readonly body: Spec<R>["body"] extends Raw<"image"> ? Blob : Spec<R>["body"] }) & {
    readonly signal?: AbortSignal;
  };

type Args<R extends Route> =
  Partial<Input<R>> extends Input<R> ? [input?: Input<R>] : [input: Input<R>];

/** Routes that answer with bytes or lines rather than JSON. */
export type RawRoute = {
  [R in Route]: Spec<R>["response"] extends Raw<"image" | "ndjson" | "text"> ? R : never;
}[Route];
export type JsonRoute = Exclude<Route, RawRoute>;

interface Loose {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: object;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

function urlOf(route: string, { params = {}, query = {} }: Loose = {}): string {
  const path = route
    .slice(route.indexOf(" ") + 1)
    .replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ""));
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `${path}?${encoded}` : path;
}

/** A route's URL with its `:name` segments filled and encoded: for `<img src>` and the like. */
export function url<R extends Route>(route: R, ...[input]: Args<R>): string {
  return urlOf(route, input);
}

async function send(route: string, input: Loose = {}): Promise<Response> {
  const { body, signal } = input;
  const headers = proofHeaders();
  const init: RequestInit = {
    method: route.slice(0, route.indexOf(" ")),
    credentials: "same-origin",
    signal,
    headers,
  };
  if (body instanceof Blob) {
    init.body = body;
    headers["Content-Type"] = body.type || "application/octet-stream";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  let response: Response;
  try {
    response = await fetch(urlOf(route, input), init);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, "unreachable", String(error));
  }
  if (!response.ok) throw await errorFrom(response);
  return response;
}

/** One JSON call: call("PUT /api/local/personas/:id/prompt", { params: { id }, body: { text } }). */
export async function call<R extends JsonRoute>(
  route: R,
  ...[input]: Args<R>
): Promise<Spec<R>["response"]> {
  const response = await send(route, input);
  try {
    return (await response.json()) as Spec<R>["response"];
  } catch {
    throw new ApiError(response.status, "bad-response", "not JSON");
  }
}

/** A raw route's body, such as a job's events for readNdjson. */
export async function stream<R extends RawRoute>(
  route: R,
  ...[input]: Args<R>
): Promise<ReadableStream<Uint8Array>> {
  const response = await send(route, input);
  if (!response.body) throw new ApiError(response.status, "bad-response", "no body");
  return response.body;
}
