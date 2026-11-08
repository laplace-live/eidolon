// Account keys being typed, saved and checked, as the setup wizard asks for them.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { refreshAccounts } from "@/lib/accounts";
import { asApiError, call } from "@/lib/api";
import type { CheckOutcome } from "./check-result";

export function useAccountKeys() {
  const queryClient = useQueryClient();
  const [typed, setTypedState] = useState<Readonly<Record<string, string>>>({});
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, CheckOutcome>>>({});
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);

  function setTyped(account: string, value: string) {
    setTypedState((current) => ({ ...current, [account]: value }));
    setOutcomes(({ [account]: _, ...rest }) => rest);
  }

  /** Checks a key typed but not saved, or without one the key the account has. */
  async function check(account: string, value?: string): Promise<CheckOutcome> {
    const apiKey = value?.trim() || undefined;
    setChecking((current) => new Set(current).add(account));
    let outcome: CheckOutcome;
    try {
      outcome = {
        result: await call("POST /api/local/accounts/check", { body: { account, apiKey } }),
      };
    } catch (error) {
      outcome = { error: asApiError(error) };
    }
    setOutcomes((current) => ({ ...current, [account]: outcome }));
    setChecking((current) => {
      const next = new Set(current);
      next.delete(account);
      return next;
    });
    return outcome;
  }

  /** Saves every key typed into its account and clears what was typed. */
  async function save(): Promise<void> {
    const entries = Object.entries(typed)
      .map(([account, value]) => [account, value.trim()] as const)
      .filter(([, value]) => value !== "");
    if (entries.length === 0) return;
    setSaving(true);
    try {
      for (const [account, apiKey] of entries) {
        await call("PUT /api/local/accounts/:id", { params: { id: account }, body: { apiKey } });
      }
      setTypedState({});
      await refreshAccounts(queryClient);
    } finally {
      setSaving(false);
    }
  }

  return { typed, outcomes, checking, saving, setTyped, check, save };
}

export type AccountKeys = ReturnType<typeof useAccountKeys>;
