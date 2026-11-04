// GET /api/memories and POST /api/memories/forget. Anonymous callers get 401 even when Mem0 is
// unconfigured, so a misconfigured deployment cannot leak the existence of anyone's memories.
import type { LoggedInUser } from "@eidolon/access";
import { errorText, logger, pyRepr } from "@eidolon/config";
import type { AdminOutcome, MemoryAdmin } from "@eidolon/memory";
import { jsonResponse } from "./responses.ts";

export const LIST_MEMORIES_PATH = "/api/memories";
export const FORGET_MEMORIES_PATH = "/api/memories/forget";

const UNAVAILABLE = { error: "Mem0 service unavailable" };

export interface MemoryRouteParts {
  readonly resolveBearerCaller: (authorization: string | null) => Promise<LoggedInUser | null>;
  /** null when memory is not configured. */
  readonly admin: MemoryAdmin | null;
}

type AdminFailure = Extract<AdminOutcome<unknown>, { ok: false }>;

/** Python `type(e).__name__`: @eidolon/memory names its errors after mem0's exception classes. */
function errorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return error.name !== "Error" ? error.name : error.constructor.name || error.name;
}

function failure(outcome: AdminFailure, operation: string, message: string): Response {
  if (outcome.reason === "unavailable") {
    logger.error(
      `[memory-admin] Could not reach the Mem0 vector store: ${errorText(outcome.error)}`,
    );
    return jsonResponse(503, UNAVAILABLE);
  }
  logger.error(
    `[memory-admin] ${operation}: ${errorType(outcome.error)}: ${errorText(outcome.error)}`,
  );
  return jsonResponse(502, { error: message });
}

export async function listMemories(request: Request, parts: MemoryRouteParts): Promise<Response> {
  const user = await parts.resolveBearerCaller(request.headers.get("authorization"));
  if (user === null) return jsonResponse(401, { error: "需要登录后才能查看记忆" });
  if (parts.admin === null) return jsonResponse(503, UNAVAILABLE);
  const userId = String(user.mid);
  const outcome = await parts.admin.list(userId);
  if (!outcome.ok) {
    return failure(outcome, `get_all failed for mid=${userId}`, "Failed to load memories");
  }
  const memories = outcome.value;
  logger.info(
    `[memory-admin] Listed ${memories.length} memories for mid=${userId} (${pyRepr(user.uname)})`,
  );
  return jsonResponse(200, {
    user_id: userId,
    uname: user.uname,
    count: memories.length,
    memories,
  });
}

/** Idempotent: an empty namespace is forgotten again with the same 200. */
export async function forgetMemories(request: Request, parts: MemoryRouteParts): Promise<Response> {
  const user = await parts.resolveBearerCaller(request.headers.get("authorization"));
  if (user === null) return jsonResponse(401, { error: "需要登录后才能管理记忆" });
  if (parts.admin === null) return jsonResponse(503, UNAVAILABLE);
  const userId = String(user.mid);
  const outcome = await parts.admin.forget(userId);
  if (!outcome.ok) {
    return failure(outcome, `delete_all failed for mid=${userId}`, "Failed to delete memories");
  }
  logger.info(`[memory-admin] Wiped Mem0 memories for mid=${userId} (${pyRepr(user.uname)})`);
  return jsonResponse(200, { ok: true, user_id: userId });
}
