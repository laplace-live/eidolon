import { useQuery } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { statusQuery } from "@/lib/query";
import { TasksList } from "./list";

/** /tasks lists them, read-only; while Assistant Mode is off, it leads home. */
export function Component() {
  // The session gate primes it, so whether Assistant Mode is on is known from the first render.
  const assistant = useQuery(statusQuery).data?.assistant;
  if (!assistant) return null;
  if (!assistant.enabled) return <Redirect to="/" replace />;
  return <TasksList assistant={assistant} />;
}
