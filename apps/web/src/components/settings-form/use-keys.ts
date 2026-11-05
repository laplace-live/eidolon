import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ApiError,
  type CheckResult,
  type CredentialsResponse,
  type CredentialsUpdate,
  call,
} from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { CHECK_OF } from "./credentials";
import { credentialsQuery } from "./queries";

/** A check's verdict, or why the check itself couldn't run. */
export type CheckOutcome =
  | { readonly result: CheckResult; readonly error?: undefined }
  | { readonly error: ApiError; readonly result?: undefined };

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, "unreachable", String(error));
}

/** Keys being typed, saved and checked. */
export function useKeys() {
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialsQuery);
  const [typed, setTypedState] = useState<Readonly<Record<string, string>>>({});
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, CheckOutcome>>>({});
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);

  function setTyped(name: string, value: string) {
    setTypedState((current) => ({ ...current, [name]: value }));
    setOutcomes(({ [name]: _, ...rest }) => rest);
  }

  /**
   * Checks `value`, a key typed but not saved, or without one the key the bot will use: the
   * saved one, or the environment's.
   */
  async function check(name: string, value?: string): Promise<CheckOutcome | null> {
    const provider = CHECK_OF[name];
    if (!provider) return null;
    const unsaved = value?.trim() || undefined;
    setChecking((current) => new Set(current).add(name));
    let outcome: CheckOutcome;
    try {
      outcome = {
        result: await call("POST /api/local/credentials/check", {
          body: { provider, value: unsaved },
        }),
      };
    } catch (error) {
      outcome = { error: asApiError(error) };
    }
    setOutcomes((current) => ({ ...current, [name]: outcome }));
    setChecking((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    return outcome;
  }

  async function write(update: CredentialsUpdate): Promise<CredentialsResponse> {
    setSaving(true);
    try {
      const saved = await call("PUT /api/local/credentials", { body: update });
      queryClient.setQueryData(credentialsQuery.queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
      return saved;
    } finally {
      setSaving(false);
    }
  }

  /** Saves every typed key and clears what was typed; the names saved come back with the state. */
  async function save(): Promise<{ saved: string[]; state: CredentialsResponse | undefined }> {
    const update = Object.fromEntries(
      Object.entries(typed)
        .map(([name, value]) => [name, value.trim()] as const)
        .filter(([, value]) => value !== ""),
    );
    const saved = Object.keys(update);
    if (saved.length === 0) return { saved, state: credentials.data };
    const state = await write(update);
    setTypedState({});
    return { saved, state };
  }

  async function remove(name: string): Promise<void> {
    await write({ [name]: null });
    setOutcomes(({ [name]: _, ...rest }) => rest);
  }

  return { credentials, typed, setTyped, outcomes, checking, check, save, remove, saving };
}

export type Keys = ReturnType<typeof useKeys>;
