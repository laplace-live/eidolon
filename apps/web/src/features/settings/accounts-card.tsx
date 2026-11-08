// Settings → Providers: the accounts Eidolon calls, each a provider with its key, API base and
// settings, more than one of a provider where you have them. A persona picks one per role in her
// studio; the accounts her calls need show here even before they have a key.

import { ph, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { QuietBadge } from "@/components/quiet-badge";
import { FieldSkeletons, SectionCard } from "@/components/section-card";
import { type CheckOutcome, CheckResultView } from "@/components/settings-form/check-result";
import { personasQuery } from "@/components/settings-form/queries";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { accountsQuery, refreshAccounts } from "@/lib/accounts";
import { type AccountView, asApiError, call, type PersonaSummary } from "@/lib/api";
import { listOf, ROLE_LABELS } from "@/lib/labels";
import { providerById, providerName, type RoleId } from "@/lib/providers";
import { AccountDialog } from "./account-dialog";

function keyState(account: AccountView): { dot: string; text: string } {
  const provider = providerById(account.provider);
  if (account.key.source === "env") {
    return { dot: "bg-success", text: t`From the environment` };
  }
  if (account.key.source !== null) return { dot: "bg-success", text: t`Saved` };
  if (provider?.credential === null || provider?.keyOptional) {
    return { dot: "bg-muted-foreground/40", text: t`Takes no key` };
  }
  return account.needed
    ? { dot: "bg-warning", text: t`No key: calls need one` }
    : { dot: "bg-muted-foreground/40", text: t`No key` };
}

/** Who names the account: "奶绿: Chat, Memory", and the install's own roles. */
function usesText(
  account: AccountView,
  personas: readonly PersonaSummary[] | undefined,
): string | null {
  if (account.uses.length === 0) return null;
  const byOwner = new Map<string, string[]>();
  for (const use of account.uses) {
    const owner =
      use.persona === null
        ? t`Every persona`
        : (personas?.find((persona) => persona.id === use.persona)?.shortName ?? use.persona);
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), t(ROLE_LABELS[use.role as RoleId])]);
  }
  const parts = [...byOwner].map(([owner, names]) => {
    const roles = listOf(names);
    return t`${owner}: ${roles}`;
  });
  return parts.join(" · ");
}

function AccountRow({
  account,
  personas,
  onEdit,
  onRemove,
}: {
  readonly account: AccountView;
  readonly personas: readonly PersonaSummary[] | undefined;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const { t } = useLingui();
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  const check = useMutation({
    mutationFn: () => call("POST /api/local/accounts/check", { body: { account: account.id } }),
    onSuccess: (result) => setOutcome({ result }),
    onError: (error) => setOutcome({ error: asApiError(error) }),
  });
  const state = keyState(account);
  const uses = usesText(account, personas);
  const custom = account.baseUrl.source !== null && account.baseUrl.source !== "default";
  const kind = providerName(account.provider);
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{account.name}</span>
            {account.name !== kind && <span className="text-muted-foreground text-sm">{kind}</span>}
            <QuietBadge dot={state.dot}>{state.text}</QuietBadge>
          </div>
          {custom && (
            <p className="wrap-anywhere text-muted-foreground text-xs">
              {t`API base: ${ph({ url: account.baseUrl.value ?? "" })}`}
            </p>
          )}
          {uses && <p className="text-muted-foreground text-xs">{uses}</p>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending && <Spinner />}
            {t`Check`}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Edit ${ph({ name: account.name })}`}
            onClick={onEdit}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={t`Remove ${ph({ name: account.name })}`}
            disabled={account.uses.length > 0 || (!account.saved && account.key.source === "env")}
            title={
              account.uses.length > 0
                ? t`A persona uses this account: pick another for her first.`
                : undefined
            }
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      {outcome && <CheckResultView provider={account.provider} outcome={outcome} />}
    </li>
  );
}

export function AccountsCard() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const accounts = useQuery(accountsQuery);
  const personas = useQuery(personasQuery).data?.personas;
  const [editing, setEditing] = useState<AccountView | "new" | null>(null);
  const [removing, setRemoving] = useState<AccountView | null>(null);
  const remove = useMutation({
    mutationFn: (account: AccountView) =>
      call("DELETE /api/local/accounts/:id", { params: { id: account.id } }),
    onSuccess: async (_, account) => {
      toast.success(t`${ph({ name: account.name })} removed.`);
      await refreshAccounts(queryClient);
    },
    onError: (error) =>
      toast.error(t`The account couldn't be removed.`, { description: String(error) }),
  });
  const list = accounts.data?.accounts ?? [];
  return (
    <SectionCard
      title={t`Provider Accounts`}
      description={t`The accounts Eidolon calls, each with its own key and API base. Add as many of one provider as you have; a persona picks which account does each part of her work in her studio.`}
      action={
        <Button size="sm" onClick={() => setEditing("new")}>
          <PlusIcon data-icon="inline-start" />
          {t`Add Provider`}
        </Button>
      }
      note={
        <span className="flex items-center gap-1.5">
          <LockIcon className="size-3.5 shrink-0" aria-hidden />
          {t`Keys are saved in credentials.json, readable only by you, and never shown again.`}
        </span>
      }
    >
      {accounts.isPending ? (
        <FieldSkeletons rows={3} />
      ) : accounts.isError ? (
        <ErrorAlert error={accounts.error} />
      ) : list.length === 0 ? (
        <EmptyState
          title={t`No accounts yet`}
          description={t`Add the providers you have keys for, then pick them in a persona's studio.`}
        />
      ) : (
        <ul className="flex flex-col divide-y">
          {list.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              personas={personas}
              onEdit={() => setEditing(account)}
              onRemove={() => setRemoving(account)}
            />
          ))}
        </ul>
      )}
      <AccountDialog
        open={editing !== null}
        account={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
      />
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Remove ${ph({ name: removing?.name ?? "" })}?`}</AlertDialogTitle>
            <AlertDialogDescription>{t`Its key and settings are deleted from credentials.json. A key the environment sets stays.`}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) remove.mutate(removing);
                setRemoving(null);
              }}
            >
              {t({ message: `Remove`, context: "delete an account" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
