import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { accountsQuery, modelsQuery } from "@/lib/accounts";
import type { SettingsResponse } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { refreshSettings, settingsQuery } from "./queries";

const rows = (persona: string): SettingsResponse => ({
  persona,
  settings: [],
  voiceStyles: { own: [], environment: [], builtInHints: {} },
  warnings: [],
  restartRequired: false,
});

test("a save's answer becomes her rows, and every other persona's rows and the status reload", async () => {
  const client = new QueryClient();
  const keys = {
    saved: settingsQuery("alice").queryKey,
    active: settingsQuery().queryKey,
    other: settingsQuery("bob").queryKey,
  };
  for (const key of Object.values(keys)) client.setQueryData(key, rows("before"));
  client.setQueryData(statusQuery.queryKey, {} as never);
  client.setQueryData(accountsQuery.queryKey, { accounts: [] });
  const models = modelsQuery("openrouter", "llm").queryKey;
  client.setQueryData(models, { status: "ok", models: [] });

  const answer = rows("alice");
  await refreshSettings(client, "alice", answer);

  expect(client.getQueryData(keys.saved)).toEqual(answer);
  expect(client.getQueryState(keys.saved)?.isInvalidated).toBe(false);
  // The active persona's rows, under no id, may be alice's too.
  expect(client.getQueryState(keys.active)?.isInvalidated).toBe(true);
  expect(client.getQueryState(keys.other)?.isInvalidated).toBe(true);
  expect(client.getQueryState(statusQuery.queryKey)?.isInvalidated).toBe(true);
  // Which settings name an account decides whether it can be removed; its model lists stay.
  expect(client.getQueryState(accountsQuery.queryKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(models)?.isInvalidated).toBe(false);
});
