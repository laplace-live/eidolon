// POST /api/local/personas/:id/batches: the videos an expand job previewed, saved as a new batch in
// the persona's URL lists for a pipeline job to name. This file is how URLs reach the CLI.
import { basename } from "node:path";
import { isPlainObject, sourceFolder } from "@eidolon/config";
import { download } from "@eidolon/ingest";
import { checkUrl } from "../jobs/argv.ts";
import { personaRefusal } from "../personas.ts";
import { localError, localJson, readJson } from "../responses.ts";
import type { LocalRouteSpec } from "../router.ts";
import { ensureDataHome } from "../write.ts";

/** A playlist expands to a few thousand videos at most; a JSON body caps at 1 MiB anyway. */
export const MAX_BATCH_URLS = 5000;

// The errors reading a list throws: its line that names no video, or its bytes.
const LIST_ERRORS = new Set(["ValueError", "UnicodeDecodeError"]);

/** `forgetPlan` drops the persona's cached plan, which a new batch outdates. */
export function batchesRoutes(forgetPlan: (persona: string) => void): LocalRouteSpec[] {
  return [
    {
      route: "POST /api/local/personas/:id/batches",
      async handler(request, { params }) {
        const persona = params.id as string;
        const refused = personaRefusal(persona);
        if (refused !== null) return refused;
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const { value } = body;
        if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "urls")) {
          return localError(400, "bad-request", "Send {urls}");
        }
        const urls = value.urls;
        if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_BATCH_URLS) {
          return localError(400, "bad-request", `Send 1 to ${MAX_BATCH_URLS} URLs`);
        }
        // What the lists key each video by: a Bilibili video's BV id, another site's URL as sent.
        const keys = new Set<string>();
        for (const [index, raw] of urls.entries()) {
          const url = checkUrl(raw);
          const key = url === null ? null : download.listKey(url);
          if (key === null) {
            return localError(
              400,
              "invalid-url",
              `URL ${index + 1} is not a video URL a batch holds`,
            );
          }
          keys.add(key);
        }
        const lists = sourceFolder(persona, "lists");
        let known: Set<string>;
        try {
          known = download.knownIds(lists);
        } catch (error) {
          // The list reader's own words, as the CLI prints them; anything else is a 500.
          if (error instanceof Error && LIST_ERRORS.has(error.name)) {
            return localError(409, "conflict", error.message);
          }
          throw error;
        }
        const fresh = [...keys].filter((key) => !known.has(key));
        if (fresh.length === 0) return localJson(200, { batch: null, count: 0, known: keys.size });
        ensureDataHome();
        const at = new Date();
        let path: string;
        try {
          path = download.writeBatch(
            lists,
            fresh,
            [
              "Source: Eidolon's web app",
              `Captured: ${download.localIsoSeconds(at)}`,
              `URLs: ${keys.size}; new: ${fresh.length}`,
            ],
            at,
          );
        } catch (error) {
          if (error instanceof Error && error.name === "FileExistsError") {
            return localError(409, "conflict", "A batch was saved this same second; try again");
          }
          throw error;
        }
        forgetPlan(persona);
        return localJson(201, {
          batch: basename(path, ".txt"),
          count: fresh.length,
          known: keys.size - fresh.length,
        });
      },
    },
  ];
}
