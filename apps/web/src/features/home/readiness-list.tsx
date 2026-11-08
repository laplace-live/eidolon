import { useLingui } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ListCard, ListRow } from "@/components/list";
import { verdictMessage } from "@/components/settings-form/check-labels";
import { checkTone } from "@/components/settings-form/credentials";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RestartButton } from "@/features/settings/restart-button";
import { call } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { Fix, Item, Tone } from "./readiness";
import { CHECK_TITLES, FIX_LABELS, READY_TEXT } from "./readiness-labels";

const TONES: Readonly<Record<Tone, { icon: typeof InfoIcon; className: string }>> = {
  ok: { icon: CircleCheckIcon, className: "text-success" },
  info: { icon: InfoIcon, className: "text-muted-foreground" },
  warn: { icon: TriangleAlertIcon, className: "text-warning" },
  error: { icon: CircleXIcon, className: "text-destructive" },
};

function CheckButton({ target }: { readonly target: "qdrant" | { readonly account: string } }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: () =>
      target === "qdrant"
        ? call("POST /api/local/credentials/check", { body: { provider: "qdrant" } })
        : call("POST /api/local/accounts/check", { body: { account: target.account } }),
    onSuccess: async (result) => {
      const text = t(verdictMessage(target === "qdrant" ? "qdrant" : "fish", result));
      const tone = checkTone(result);
      if (tone === "ok") toast.success(text);
      else if (tone === "warn") toast.warning(text, { description: result.warnings[0]?.message });
      else toast.error(text, { description: result.message });
      await queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
    },
    onError: toastError,
  });
  return (
    <Button variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
      {check.isPending && <Spinner />}
      {t`Check`}
    </Button>
  );
}

function FixButton({
  fix,
  quiet,
  onPickVoice,
}: {
  readonly fix: Fix;
  /** A change to something that works, rather than a fix. */
  readonly quiet: boolean;
  readonly onPickVoice: () => void;
}) {
  const { t } = useLingui();
  const variant = quiet ? "ghost" : "outline";
  switch (fix.kind) {
    case "link":
      return (
        <Button variant={variant} size="sm" asChild>
          <Link to={fix.to}>{t(FIX_LABELS[fix.label])}</Link>
        </Button>
      );
    case "pick-voice":
      return (
        <Button variant={variant} size="sm" onClick={onPickVoice}>
          {t(FIX_LABELS[fix.label])}
        </Button>
      );
    case "check":
      return <CheckButton target={fix.target} />;
    case "restart":
      return <RestartButton label={t(FIX_LABELS["home.fix.restart"])} variant="outline" />;
  }
}

/** What calls and builds need, each with the action that fixes it. */
export function ReadinessList({
  items,
  onPickVoice,
}: {
  readonly items: readonly Item[];
  readonly onPickVoice: () => void;
}) {
  const { t, i18n } = useLingui();
  return (
    <ListCard label={t`Readiness`}>
      {items.map((item) => {
        const { icon: Icon, className } = TONES[item.tone];
        return (
          <ListRow
            key={item.id}
            leading={<Icon className={cn("size-5", className)} aria-hidden />}
            title={t(CHECK_TITLES[item.id])}
            description={
              <>
                {i18n._({ ...READY_TEXT[item.text], values: item.vars })}
                {item.detail && (
                  <span className="mt-1 block break-words font-mono text-xs">{item.detail}</span>
                )}
              </>
            }
            trailing={
              item.fix && (
                <FixButton fix={item.fix} quiet={item.tone === "ok"} onPickVoice={onPickVoice} />
              )
            }
          />
        );
      })}
    </ListCard>
  );
}
