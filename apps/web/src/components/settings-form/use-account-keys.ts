// Account keys being typed, saved and checked, as the setup wizard asks for them, with the
// provider's own settings an account needs beside its key, such as MiniMax's group id.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { refreshAccounts } from "@/lib/accounts";
import { type AccountUpdate, asApiError, call } from "@/lib/api";
import type { CheckOutcome } from "./check-result";

type Options = Readonly<Record<string, string>>;

export function useAccountKeys() {
  const queryClient = useQueryClient();
  const [typed, setTypedState] = useState<Readonly<Record<string, string>>>({});
  const [options, setOptionsState] = useState<Readonly<Record<string, Options>>>({});
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, CheckOutcome>>>({});
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);

  function setTyped(account: string, value: string) {
    setTypedState((current) => ({ ...current, [account]: value }));
    setOutcomes(({ [account]: _, ...rest }) => rest);
  }

  function setOption(account: string, key: string, value: string) {
    setOptionsState((current) => ({
      ...current,
      [account]: { ...current[account], [key]: value },
    }));
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

  /** Saves what was typed for each of `accounts` into it, and clears what was typed. */
  async function save(accounts: readonly string[]): Promise<void> {
    const updates: [string, AccountUpdate][] = [];
    for (const account of accounts) {
      const apiKey = typed[account]?.trim() ?? "";
      const filled = Object.entries(options[account] ?? {})
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value !== "");
      if (apiKey === "" && filled.length === 0) continue;
      updates.push([
        account,
        {
          ...(apiKey === "" ? {} : { apiKey }),
          ...(filled.length === 0 ? {} : { options: Object.fromEntries(filled) }),
        },
      ]);
    }
    if (updates.length === 0) return;
    setSaving(true);
    try {
      for (const [account, body] of updates) {
        await call("PUT /api/local/accounts/:id", { params: { id: account }, body });
      }
      setTypedState({});
      setOptionsState({});
      await refreshAccounts(queryClient);
    } finally {
      setSaving(false);
    }
  }

  return { typed, options, outcomes, checking, saving, setTyped, setOption, check, save };
}

export type AccountKeys = ReturnType<typeof useAccountKeys>;
