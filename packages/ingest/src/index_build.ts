// What both ingests share around a table rebuild: the embedding client built at the first cache
// miss, the embedding cache, the build record beside the table, and a failure's report.
import { existsSync } from "node:fs";
import { errorText, logger, pyPath } from "@eidolon/config";
import { defaultEmbeddingClient, EmbedCache, type EmbeddingClient } from "@eidolon/retrieval";
import { type Failure, failureOf } from "./failure.ts";
import { writeTextAtomic } from "./paths.ts";

class MissingCredentialError extends Error {
  override name = "MissingCredentialError";
}

/** The env-configured client, built at the first cache miss, so a fully cached run needs no key. */
export const lazyDefaultClient: Pick<EmbeddingClient, "embedWithUsage"> = {
  embedWithUsage(texts, options) {
    let client: EmbeddingClient;
    try {
      client = defaultEmbeddingClient();
    } catch (error) {
      throw new MissingCredentialError(errorText(error));
    }
    return client.embedWithUsage(texts, options);
  },
};

/** Opens the cache at `path`, emptied first when `clear` asks and it existed, and logs its size. */
export function openEmbedCache(path: string, clear: boolean): EmbedCache {
  const existed = existsSync(path);
  const cache = new EmbedCache(path);
  if (clear && existed) {
    cache.clear();
    logger.info(`Cleared embedding cache at ${pyPath(path)}`);
  }
  logger.info(`Embedding cache: ${pyPath(path)} (${cache.count()} vectors on disk)`);
  return cache;
}

/** Where a table's build record sits beside it. */
export function indexMetaPath(dbPath: string, table: string): string {
  return pyPath(`${dbPath}/${table}.meta.json`);
}

/** Records the build that wrote `table` in `<table>.meta.json` beside it. */
export function writeIndexMeta(dbPath: string, table: string, meta: object): void {
  writeTextAtomic(indexMetaPath(dbPath, table), `${JSON.stringify(meta, null, 2)}\n`);
}

/** Logs why the ingest `label` failed, and returns its failed stage's message and code. */
export function ingestFailure(
  error: unknown,
  label: string,
): { message: string } & Partial<Failure> {
  const message = errorText(error);
  if (error instanceof MissingCredentialError) {
    logger.error(message);
    return { message, code: "missing-credential" };
  }
  logger.error(`${label} failed: ${message}`, error);
  return { message, ...failureOf(error, "embeddings") };
}
