// What a provider check says: its verdict for each code, a provider's own where it has one, and
// each warning a passing check can carry.
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { CheckCode, CheckWarningCode } from "@/lib/api";

const VERDICTS: Readonly<Record<CheckCode, MessageDescriptor>> = {
  ok: msg`Key accepted`,
  missing: msg`Nothing to check: no key is saved.`,
  "invalid-key": msg`The provider rejected this key.`,
  "management-key": msg`This is a management key, which can't run models. Create a regular API key.`,
  "no-credit": msg`The account has no credit left.`,
  forbidden: msg`The key isn't allowed to do this. Check its permissions and budget.`,
  "not-found": msg`The provider couldn't find what the check asked for.`,
  "rate-limited": msg`The provider is busy. Try again in a minute.`,
  unreachable: msg`Couldn't reach the provider.`,
  unexpected: msg`The provider sent an answer the check doesn't recognize.`,
  "not-qdrant": msg`Something answers there, but it isn't Qdrant.`,
  "needs-api-key": msg`This Qdrant wants an API key, which Eidolon doesn't support.`,
  starting: msg`Qdrant is still starting. Try again in a few seconds.`,
};

const OWN_VERDICTS: Readonly<Record<string, Partial<Record<CheckCode, MessageDescriptor>>>> = {
  soniox: {
    "invalid-key": msg`Soniox rejected this key. A key from an EU, Japan or India project doesn't work either: Eidolon supports US projects only.`,
  },
  qdrant: {
    ok: msg`Qdrant is answering.`,
    missing: msg`No Qdrant address is set.`,
    unreachable: msg`Nothing answers there. Is the container running?`,
  },
};

const WARNINGS: Readonly<Record<CheckWarningCode, MessageDescriptor>> = {
  "cannot-list-models": msg`The key works but can't list models. Make sure it may use real-time and async transcription and upload files.`,
  "unknown-model": msg`The provider doesn't list the model in your settings.`,
  "deprecated-model": msg`The voice model s1 retires on 2026-12-31. Switch to drama-3.`,
  "free-tier": msg`This OpenRouter account never bought credits, so paid models will fail.`,
  "key-limit-reached": msg`The key's own spending limit is used up.`,
  "budget-exhausted": msg`A budget this key falls under is used up.`,
  "key-expired": msg`The key has expired.`,
  "key-expiring": msg`The key expires within 14 days.`,
  "no-credit": msg`No API credit, and the voice model is a paid one. Add credit on fish.audio.`,
  "voice-unknown": msg`Fish doesn't know this persona's voice. Pick another.`,
  "voice-private": msg`This persona's voice belongs to another account. Pick a public one.`,
  "cannot-verify": msg`This provider offers nothing to check a key against, so it wasn't verified.`,
  "version-mismatch": msg`This Qdrant's version is more than one minor release away from the one Eidolon is built for.`,
};

/**
 * What a check's verdict says: the provider's own sentence for its code, else the code's, else a
 * plain passed or failed, the server's English message then saying the rest.
 */
export function verdictMessage(
  provider: string,
  result: { readonly ok: boolean; readonly code: string },
): MessageDescriptor {
  const code = result.code as CheckCode;
  return (
    OWN_VERDICTS[provider]?.[code] ??
    VERDICTS[code] ??
    (result.ok ? msg`Check passed` : msg`Check failed`)
  );
}

/** A warning's sentence, or null when only the server's English message describes it. */
export function warningMessage(code: string): MessageDescriptor | null {
  return WARNINGS[code as CheckWarningCode] ?? null;
}
