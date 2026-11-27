import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { InfoIcon, LockIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";
import { ErrorAlert } from "@/components/error-alert";
import { FieldSkeletons } from "@/components/section-card";
import { AccountKeyField, NoKeyField } from "@/components/settings-form/account-key-field";
import {
  effectiveProvider,
  effectiveProviderType,
  fallbackModel,
  REINDEX_PATHS,
  strip,
} from "@/components/settings-form/controls";
import { PROVIDER_OFF_LABELS } from "@/components/settings-form/labels";
import { refreshSettings, settingsQuery } from "@/components/settings-form/queries";
import { ReindexDialog } from "@/components/settings-form/reindex-dialog";
import { useAccountKeys } from "@/components/settings-form/use-account-keys";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { accountsQuery } from "@/lib/accounts";
import { type AccountView, type ApiError, asApiError, call, type SettingRow } from "@/lib/api";
import { listOf, ROLE_LABELS } from "@/lib/labels";
import {
  OFF_PROVIDER,
  providerById,
  providerName,
  providerOfAccount,
  roleById,
  SETUP_ROLES,
} from "@/lib/providers";
import { statusQuery } from "@/lib/query";
import {
  activeRiders,
  callNeeds,
  choicesFor,
  envLock,
  keyNeeds,
  missingFields,
  modelAfter,
  type Picked,
  type PickedRole,
  pickChanges,
} from "./choices";
import { RECOMMENDED_ROLES, requiredKeyMissing } from "./first-run";
import { StepCard } from "./step-card";
import { cookieDefault, isNewInstall } from "./wizard";

const ROLE_HINTS = {
  hearing: msg`Hears you on calls and in voice messages.`,
  mind: msg`Thinks and writes her replies.`,
  voice: msg`Speaks her replies.`,
  embeddings: msg`Finds her memories and what she knows. Every persona shares it.`,
  gate: msg`A decision model: whether a line needs what she knows looked up, and who answers in a group chat.`,
} satisfies Record<PickedRole, MessageDescriptor>;

/** Which account fills one role, the recommended one marked, and the model it runs. */
export function RolePicker({
  role,
  rows,
  drafts,
  accounts,
  invalid,
  disabled,
  onDraft,
}: {
  readonly role: PickedRole;
  readonly rows: readonly SettingRow[];
  readonly drafts: Readonly<Record<string, string>>;
  readonly accounts: readonly AccountView[] | undefined;
  /** A save was tried while it still needs a model named. */
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly onDraft: (path: string, value: string) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const entry = roleById(role);
  const path = `${entry.path}.provider`;
  const modelPath = `${entry.path}.model`;
  const locked = envLock(entry, rows);
  const current = effectiveProvider(entry, rows, drafts);
  const providerType = providerOfAccount(current, accounts);
  const moved = effectiveProviderType(entry, rows, {}, accounts) !== providerType;
  const model = modelAfter(entry, rows, drafts, accounts);
  const modelRow = rows.find((row) => row.path === modelPath);
  const inheritedModel = !moved && modelRow?.envValue ? strip(modelRow.envValue) || null : null;
  const defaultModelId = inheritedModel ?? fallbackModel(entry, rows, drafts, accounts);
  const savedModel =
    !moved && modelRow && modelRow.source !== "default" && typeof modelRow.value === "string"
      ? modelRow.value
      : "";
  const offLabel = PROVIDER_OFF_LABELS[role];
  const customizable = providerType === "openai-compatible";
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t(ROLE_LABELS[role])}</FieldLabel>
      <Select
        value={current ?? ""}
        onValueChange={(next) => onDraft(path, next)}
        disabled={disabled || locked !== undefined}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choicesFor(entry, accounts, current).map((choice) => (
            <SelectItem key={choice.account} value={choice.account}>
              {choice.account === OFF_PROVIDER ? (offLabel ? t(offLabel) : t`Off`) : choice.name}
              {choice.recommended && <Badge variant="secondary">{t`Recommended`}</Badge>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>{t(ROLE_HINTS[role])}</FieldDescription>
      {locked ? (
        <FieldDescription>
          {t`Set by ${ph({ env: locked.env })} in the environment, which wins over the value saved here. Change it there.`}
        </FieldDescription>
      ) : current === OFF_PROVIDER ? null : model !== null &&
        drafts[modelPath] === undefined &&
        !customizable ? (
        <FieldDescription>
          <Trans>
            Model: <code className="font-mono text-foreground/80">{model}</code>
          </Trans>
        </FieldDescription>
      ) : (
        <>
          <Input
            aria-label={t`Model`}
            className="font-mono md:text-[0.8125rem]"
            autoComplete="off"
            spellCheck={false}
            placeholder={defaultModelId ?? t`Model ID`}
            value={drafts[modelPath] ?? (customizable ? savedModel : "")}
            aria-invalid={invalid}
            onChange={(event) => onDraft(modelPath, event.target.value)}
            disabled={disabled}
          />
          {defaultModelId === null ? (
            <FieldDescription className={invalid ? "text-destructive" : undefined}>
              {t`This account has no default model, so name the one to use.`}
            </FieldDescription>
          ) : (
            <FieldDescription>
              {t`Default: ${ph({ model: defaultModelId })}. Leave blank to use it, or enter your server's model ID.`}
            </FieldDescription>
          )}
        </>
      )}
    </Field>
  );
}

/**
 * Which providers think, hear and speak for the active persona and embed for every one, each with
 * the recommended one marked, then a key for every account they name.
 */
export function KeysStep({ onDone }: { readonly onDone: () => void }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const keys = useAccountKeys();
  const settings = useQuery(settingsQuery());
  const status = useQuery(statusQuery);
  const accounts = useQuery(accountsQuery);
  // Decided from the first answers: once the keys are saved, the install no longer looks new.
  const newInstall = useRef<boolean | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [missing, setMissing] = useState(false);
  const [checksFailed, setChecksFailed] = useState(false);

  useEffect(() => {
    if (newInstall.current === null && settings.data && accounts.data) {
      newInstall.current = isNewInstall(settings.data.settings, accounts.data.accounts);
    }
  }, [settings.data, accounts.data]);

  const rows = settings.data?.settings ?? [];
  const listed = accounts.data?.accounts;
  // A realtime model hears, thinks and speaks in one, on the account her studio picked for it.
  const realtime = status.data?.call.realtime
    ? effectiveProvider(roleById("realtime"), rows, {})
    : null;
  const picks = SETUP_ROLES.filter((role) => realtime === null || !callNeeds(role));
  const required = picks.filter((role) => callNeeds(role) && !RECOMMENDED_ROLES.has(role));
  const recommended = picks.filter((role) => RECOMMENDED_ROLES.has(role));
  const optional = picks.filter((role) => !callNeeds(role));
  const riders = activeRiders(rows, status.data?.selfieReferences ?? 0);
  const picked: Picked[] = [
    ...(realtime === null ? [] : [{ role: "realtime" as const, account: realtime, call: true }]),
    // In the order the step shows them, so the keys a chat needs come first.
    ...[...required, ...recommended, ...optional].map((role) => ({
      role,
      account: effectiveProvider(roleById(role), rows, drafts),
      call: callNeeds(role),
    })),
    ...riders.map((role) => ({
      role,
      account: effectiveProvider(roleById(role), rows, {}),
      call: false,
    })),
  ];
  const needs = keyNeeds(picked, listed);
  const modelless = picks.filter(
    (role) =>
      effectiveProvider(roleById(role), rows, drafts) !== OFF_PROVIDER &&
      modelAfter(roleById(role), rows, drafts, listed) === null,
  );
  const lacking = new Map(
    needs.map((need) => [
      need.account,
      missingFields(need, listed, keys.options[need.account], keys.baseUrls[need.account]),
    ]),
  );
  const incomplete = [...lacking.values()].some((fields) => fields.length > 0);
  const loading = settings.isPending || accounts.isPending || status.isPending;

  function draft(path: string, value: string) {
    setDrafts((current) => {
      const next = { ...current, [path]: value };
      // A model typed for one provider means nothing to another.
      if (path.endsWith(".provider")) delete next[path.replace(/\.provider$/, ".model")];
      return next;
    });
    setChecksFailed(false);
  }

  async function next(confirmed = false) {
    setTried(true);
    if (!settings.data || modelless.length > 0 || incomplete) return;
    const changes = pickChanges(rows, drafts, listed);
    // As Settings asks: another embedding provider or model costs every index and the memories
    // kept, which a new install has none of yet; another account of the same provider costs nothing.
    const embeddings = roleById("embeddings");
    const reembeds =
      effectiveProviderType(embeddings, rows, {}, listed) !==
        effectiveProviderType(embeddings, rows, drafts, listed) ||
      REINDEX_PATHS.some((path) => path in changes.app);
    if (!confirmed && newInstall.current !== true && reembeds) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    setMissing(false);
    setChecksFailed(false);
    try {
      const app = {
        ...cookieDefault(settings.data.settings, newInstall.current === true),
        ...changes.app,
      };
      if (Object.keys(changes.persona).length > 0) {
        const saved = await call("PUT /api/local/settings", {
          body: { scope: "persona", persona: settings.data.persona, values: changes.persona },
        });
        await refreshSettings(queryClient, undefined, saved);
      }
      if (Object.keys(app).length > 0) {
        const saved = await call("PUT /api/local/settings", {
          body: { scope: "app", values: app },
        });
        await refreshSettings(queryClient, undefined, saved);
      }
      setDrafts({});
      setTried(false);
      await keys.save(needs.map((need) => need.account));
      const fresh = await queryClient.query(statusQuery);
      if (requiredKeyMissing(fresh)) {
        setMissing(true);
        return;
      }
      const keyed = await queryClient.query(accountsQuery);
      const checked = keyNeeds(picked, keyed.accounts).filter((need) => {
        if (need.set) return true;
        if (need.key !== "optional") return false;
        const listedAccount = keyed.accounts.find((entry) => entry.id === need.account);
        const effectiveBase =
          listedAccount?.baseUrl.value ?? providerById(need.provider)?.baseUrl ?? null;
        return effectiveBase !== null;
      });
      const outcomes = await Promise.all(checked.map((need) => keys.check(need.account)));
      if (outcomes.every((outcome) => outcome.result?.ok)) onDone();
      else setChecksFailed(true);
    } catch (error) {
      setFailure(asApiError(error));
    } finally {
      setBusy(false);
    }
  }

  const personaName = status.data ? status.data.persona.shortName || status.data.persona.name : "";
  const picker = (role: PickedRole) => (
    <RolePicker
      key={role}
      role={role}
      rows={rows}
      drafts={drafts}
      accounts={listed}
      invalid={tried && modelless.includes(role)}
      disabled={busy}
      onDraft={draft}
    />
  );

  return (
    <StepCard
      title={t`Your API Keys`}
      description={t`Eidolon calls paid services with your own keys. Keep the recommended providers or pick others you have keys for: one provider can fill more than one part. Each needs credit on its account.`}
      note={
        <span className="flex items-center gap-1.5">
          <LockIcon className="size-3.5 shrink-0" aria-hidden />
          {t`Keys stay on this machine, readable only by you.`}
        </span>
      }
      footer={
        <>
          {checksFailed && (
            <Button variant="ghost" onClick={onDone} disabled={busy}>
              {t`Continue Anyway`}
            </Button>
          )}
          <Button onClick={() => void next()} disabled={busy || loading}>
            {busy && <Spinner />}
            {t`Save and Continue`}
          </Button>
        </>
      }
    >
      {settings.isError && <ErrorAlert error={settings.error} />}
      {accounts.isError && <ErrorAlert error={accounts.error} />}
      {loading ? (
        <div className="flex flex-col gap-6" role="status" aria-busy="true">
          <span className="sr-only">{t`Loading…`}</span>
          <FieldSkeletons rows={4} />
        </div>
      ) : (
        <>
          <FieldSet className="gap-6">
            <FieldLegend>{t`Required Providers`}</FieldLegend>
            {realtime !== null ? (
              <Alert>
                <InfoIcon />
                <AlertDescription>
                  {t`${personaName} talks through ${ph({ provider: providerName(providerOfAccount(realtime, listed)) })}'s realtime model, which hears, thinks and speaks in one. Change that in her studio.`}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2">{required.map(picker)}</div>
            )}
          </FieldSet>

          {/* A fieldset draws its legend over its own top border, so the divider is outside it. */}
          {recommended.length > 0 && (
            <div className="border-t pt-6">
              <FieldSet className="gap-6">
                <div className="flex flex-col gap-1.5">
                  <FieldLegend className="mb-0">{t`Recommended Providers`}</FieldLegend>
                  <FieldDescription>{t`Calls and voice messages need them. Without them, you can still chat in text.`}</FieldDescription>
                </div>
                <div className="grid gap-6 sm:grid-cols-2">{recommended.map(picker)}</div>
              </FieldSet>
            </div>
          )}

          <div className="border-t pt-6">
            <FieldSet className="gap-6">
              <div className="flex flex-col gap-1.5">
                <FieldLegend className="mb-0">{t`Optional Providers`}</FieldLegend>
                <FieldDescription>{t`She talks without them, but remembers and recalls less.`}</FieldDescription>
              </div>
              <div className="grid gap-6 sm:grid-cols-2">{optional.map(picker)}</div>
              <p className="inline-links text-muted-foreground text-sm">
                <Trans>
                  Another account, such as your own server or a second key, goes under{" "}
                  <Link to="/settings?tab=providers">Providers</Link>; it's listed here once added.
                </Trans>
              </p>
            </FieldSet>
          </div>

          <div className="border-t pt-6">
            <FieldSet className="gap-6">
              <FieldLegend>{t`Keys`}</FieldLegend>
              {/* Not a FieldGroup: inside its @container, Chrome 157 drops the box of a field kept
                  while the fields beside it come and go, and the key field vanishes. */}
              <div className="flex flex-col gap-7">
                {needs.map((need) => {
                  if (need.key === "none") {
                    return <NoKeyField key={need.account} need={need} keys={keys} />;
                  }
                  const off = listOf(need.roles.map((role) => t(ROLE_LABELS[role])));
                  return (
                    <AccountKeyField
                      key={need.account}
                      need={need}
                      keys={keys}
                      tier={need.tier}
                      note={
                        need.tier === "recommended"
                          ? t`Without it, calls can't start, and these stay off: ${off}.`
                          : need.tier === "optional" && need.key === "required"
                            ? t`Without it, these stay off: ${off}.`
                            : undefined
                      }
                      missing={tried ? lacking.get(need.account) : undefined}
                    />
                  );
                })}
              </div>
            </FieldSet>
          </div>
        </>
      )}

      {missing && (
        <Alert variant="destructive">
          <AlertTitle>{t`Add every required key above to continue.`}</AlertTitle>
        </Alert>
      )}
      {checksFailed && (
        <Alert>
          <AlertTitle>{t`Not every key passed its check`}</AlertTitle>
          <AlertDescription>{t`Calls fail with a key the provider refuses. Fix the keys marked above, or continue and fix them later in Settings.`}</AlertDescription>
        </Alert>
      )}
      {failure && <ErrorAlert error={failure} />}
      <ReindexDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void next(true);
        }}
      />
    </StepCard>
  );
}
