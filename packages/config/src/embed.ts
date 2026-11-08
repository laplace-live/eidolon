// Shared by retrieval (LanceDB vectors) and memory (Qdrant vectors), which must embed with the
// same model and dimension as the offline ingest.
import { envInt } from "./env.ts";

export const DEFAULT_EMBED_MODEL = "google/gemini-embedding-2-preview";

export function embedDim(): number {
  return envInt("EMBED_DIM", 3072);
}
