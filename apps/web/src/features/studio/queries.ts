// A persona's own files, each under ["personas", id, …] beside the list's ["personas"].
import { queryOptions } from "@tanstack/react-query";
import { call } from "@/lib/api";

export function personaQueries(id: string) {
  const params = { id };
  return {
    identity: queryOptions({
      queryKey: ["personas", id, "identity"],
      queryFn: ({ signal }) => call("GET /api/local/personas/:id/identity", { params, signal }),
    }),
    prompt: queryOptions({
      queryKey: ["personas", id, "prompt"],
      queryFn: ({ signal }) => call("GET /api/local/personas/:id/prompt", { params, signal }),
    }),
    glossary: queryOptions({
      queryKey: ["personas", id, "glossary"],
      queryFn: ({ signal }) => call("GET /api/local/personas/:id/glossary", { params, signal }),
    }),
    references: queryOptions({
      queryKey: ["personas", id, "references"],
      queryFn: ({ signal }) => call("GET /api/local/personas/:id/references", { params, signal }),
    }),
    facts: queryOptions({
      queryKey: ["personas", id, "facts"],
      queryFn: ({ signal }) => call("GET /api/local/personas/:id/facts", { params, signal }),
    }),
    index: queryOptions({
      queryKey: ["personas", id, "index"],
      queryFn: ({ signal }) => call("GET /api/local/personas/:id/index", { params, signal }),
    }),
  };
}

export function factQuery(id: string, file: string) {
  return queryOptions({
    queryKey: ["personas", id, "facts", file],
    queryFn: ({ signal }) =>
      call("GET /api/local/personas/:id/facts/:file", { params: { id, file }, signal }),
  });
}
