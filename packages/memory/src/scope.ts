// Which viewer a memory belongs to. mem0 validates and trims every id on every call, so a bad
// MEM0_AGENT_ID doesn't stop a session from starting; it makes each add/search/list fail and log.
import { isPySpace, pyStrip, sortedPy } from "@eidolon/config";
import { pyError } from "./errors.ts";
import type { ScopeFilters } from "./qdrant.ts";

export interface MemoryScope {
  readonly userId?: string | null;
  readonly agentId?: string | null;
  readonly runId?: string | null;
}

const KEYS = [
  ["user_id", "userId"],
  ["agent_id", "agentId"],
  ["run_id", "runId"],
] as const;

/** mem0 `_validate_and_trim_entity_id`. */
function validateId(value: string, name: string): string {
  const trimmed = pyStrip(value);
  if (trimmed === "") {
    throw pyError(
      "ValueError",
      `Invalid ${name}: cannot be empty or whitespace-only. Provide a valid identifier.`,
    );
  }
  if ([...trimmed].some(isPySpace)) {
    throw pyError(
      "ValueError",
      `Invalid ${name}: cannot contain whitespace. Provide a valid identifier without spaces.`,
    );
  }
  return trimmed;
}

/** The validated, trimmed ids in mem0's key order; throws mem0's errors. Empty when none is set. */
export function scopeFilters(scope: MemoryScope): ScopeFilters {
  const filters: Partial<Record<"user_id" | "agent_id" | "run_id", string>> = {};
  for (const [key, field] of KEYS) {
    const value = scope[field];
    if (value !== null && value !== undefined) filters[key] = validateId(value, key);
  }
  return filters;
}

function escapeScopeValue(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("&", "%26").replaceAll("=", "%3D");
}

/** mem0 `_build_session_scope`: the history DB's key for "Last k Messages", per viewer. */
export function buildSessionScope(filters: ScopeFilters): string {
  const parts: string[] = [];
  for (const key of sortedPy(["user_id", "agent_id", "run_id"]) as (keyof ScopeFilters)[]) {
    const value = filters[key];
    if (value) parts.push(`${key}=${escapeScopeValue(value)}`);
  }
  return parts.join("&");
}
