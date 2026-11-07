import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ListCard, ListRow } from "@/components/list";
import { checkTone, verdictKey } from "@/components/settings-form/credentials";
import { hasString } from "@/components/settings-form/field";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RestartButton } from "@/features/settings/restart-button";
import { call } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { Fix, Item, Tone } from "./readiness";

const TONES: Readonly<Record<Tone, { icon: typeof InfoIcon; className: string }>> = {
  ok: { icon: CircleCheckIcon, className: "text-success" },
  info: { icon: InfoIcon, className: "text-muted-foreground" },
  warn: { icon: TriangleAlertIcon, className: "text-warning" },
  error: { icon: CircleXIcon, className: "text-destructive" },
};

function CheckButton({ provider }: { readonly provider: "fish" | "qdrant" }) {
  const t = useT();
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: () => call("POST /api/local/credentials/check", { body: { provider } }),
    onSuccess: async (result) => {
      const text = t(verdictKey(provider, result, hasString));
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
      {t("home.fix.check")}
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
  const t = useT();
  const variant = quiet ? "ghost" : "outline";
  switch (fix.kind) {
    case "link":
      return (
        <Button variant={variant} size="sm" asChild>
          <Link to={fix.to}>{t(fix.label)}</Link>
        </Button>
      );
    case "pick-voice":
      return (
        <Button variant={variant} size="sm" onClick={onPickVoice}>
          {t(fix.label)}
        </Button>
      );
    case "check":
      return <CheckButton provider={fix.provider} />;
    case "restart":
      return <RestartButton label="home.fix.restart" variant="outline" />;
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
  const t = useT();
  return (
    <ListCard label={t("home.ready.title")}>
      {items.map((item) => {
        const { icon: Icon, className } = TONES[item.tone];
        return (
          <ListRow
            key={item.id}
            leading={<Icon className={cn("size-5", className)} aria-hidden />}
            title={t(`home.check.${item.id}`)}
            description={
              <>
                {t(item.text, item.vars)}
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
