// One-time import from a legacy Qdrant server when MEM0_QDRANT_HOST is still set during upgrade:
// scrolls matching-dimension points over plain fetch() into Zvec once and stamps the collection.
import { envInt, envOptional, errorText, isPlainObject, logger } from "@eidolon/config";
import type { NewPoint, ZvecVectorStore } from "./zvec.ts";

const SCROLL_LIMIT = 256;
const REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_LEGACY_QDRANT_COLLECTION = "eidolon_memories";

function qdrantBaseUrl(rawHost: string, port: number): string {
  if (/^https?:\/\//i.test(rawHost)) return rawHost.replace(/\/+$/, "");
  const host = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
  return `http://${host}:${port}`;
}

export async function migrateLegacyQdrantIfNeeded(
  store: ZvecVectorStore,
  dims: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<number> {
  const rawHost = envOptional("MEM0_QDRANT_HOST");
  if (!rawHost) return 0;
  if (store.hasQdrantMigrationMarker()) return 0;

  const port = envInt("MEM0_QDRANT_PORT", 6333);
  const collection = envOptional("MEM0_QDRANT_COLLECTION") ?? DEFAULT_LEGACY_QDRANT_COLLECTION;
  const url = `${qdrantBaseUrl(rawHost, port)}/collections/${encodeURIComponent(collection)}/points/scroll`;

  let migrated = 0;
  let validDimSeen = 0;
  let skippedWrongDim = 0;
  let offset: string | number | null = null;
  try {
    for (;;) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          limit: SCROLL_LIMIT,
          with_payload: true,
          with_vector: true,
          ...(offset !== null ? { offset } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 404) {
        store.markQdrantMigrated();
        return 0;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body: unknown = await res.json();
      const result = isPlainObject(body) && isPlainObject(body.result) ? body.result : null;
      const rawPoints = result && Array.isArray(result.points) ? result.points : [];
      const batch: NewPoint[] = [];
      for (const raw of rawPoints) {
        if (!isPlainObject(raw)) continue;
        const id = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : null;
        const vec = Array.isArray(raw.vector) ? raw.vector : null;
        if (id === null || vec === null) continue;
        if (vec.length !== dims) {
          skippedWrongDim++;
          continue;
        }
        if (!vec.every((v) => typeof v === "number" && Number.isFinite(v))) continue;
        validDimSeen++;
        const payload = isPlainObject(raw.payload) ? raw.payload : {};
        if (store.isTombstoned(id, payload) || store.hasPoint(id)) continue;
        batch.push({
          id,
          vector: vec as number[],
          payload,
        });
      }
      if (batch.length > 0) {
        await store.insert(batch);
        migrated += batch.length;
      }
      const next = result?.next_page_offset;
      if (typeof next === "string" || typeof next === "number") {
        offset = next;
      } else {
        break;
      }
    }
    if (validDimSeen === 0 && skippedWrongDim > 0) {
      logger.warning(
        `Legacy Qdrant (${rawHost}:${port}/${collection}) has ${skippedWrongDim} point(s) whose dimension does not match EMBED_DIM=${dims}; leaving migration pending`,
      );
      return 0;
    }
    store.markQdrantMigrated();
    if (migrated > 0) {
      logger.info(
        `Migrated ${migrated} viewer memories from legacy Qdrant (${rawHost}:${port}/${collection}) into Zvec`,
      );
    }
    return migrated;
  } catch (error) {
    logger.warning(
      `Legacy MEM0_QDRANT_HOST=${rawHost} is set, but Qdrant could not be reached to migrate memories (${errorText(error)}); ` +
        "continuing with local Zvec store",
    );
    return 0;
  }
}
