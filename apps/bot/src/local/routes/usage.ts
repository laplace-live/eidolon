// GET /api/local/usage: what the usage ledger recorded in a range, summed by day, persona, provider
// and model. Every call, job and MCP search of this data home writes to it.
import { ledgerPath, usageLedger } from "@eidolon/usage";
import type { UsageSummary } from "../api.ts";
import { localError, localJson } from "../responses.ts";
import type { LocalRouteSpec } from "../router.ts";
import { isPersonaId } from "../write.ts";

/** A query's ms instant: a non-negative safe integer, or absent. */
function instant(url: URL, name: string): number | null | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function usageRoutes(): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/usage",
      handler(_request, { url }) {
        const from = instant(url, "from");
        const to = instant(url, "to");
        if (from === null || to === null) {
          return localError(400, "bad-request", "from and to are ms since the epoch");
        }
        // A persona the ledger remembers may have no folder any more: only her id's shape counts.
        const persona = url.searchParams.get("persona") || null;
        if (persona !== null && !isPersonaId(persona)) {
          return localError(400, "invalid-persona-id", "A persona id is a lowercase slug");
        }
        const ledger = usageLedger();
        const range = { from: from ?? null, to: to ?? null, persona };
        const body: UsageSummary =
          ledger === null
            ? {
                ...range,
                rows: [],
                personas: [],
                providers: [],
                path: ledgerPath(),
                recording: false,
              }
            : { ...ledger.summarize(range), path: ledger.path, recording: true };
        return localJson(200, body);
      },
    },
  ];
}
