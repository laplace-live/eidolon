import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { checkTone, verdictKey } from "@/components/settings-form/credentials";
import { hasString } from "@/components/settings-form/field";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RestartButton } from "@/features/settings/restart-button";
import { call, errorKey, type Status } from "@/lib/api";
import { useLang, useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { type Fix, formatsFor, type Item, readiness, type Tone } from "./readiness";

const TONES: Readonly<Record<Tone, { icon: typeof InfoIcon; className: string }>> = {
  ok: { icon: CircleCheckIcon, className: "text-emerald-600 dark:text-emerald-400" },
  info: { icon: InfoIcon, className: "text-muted-foreground" },
  warn: { icon: TriangleAlertIcon, className: "text-amber-600 dark:text-amber-400" },
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
    onError: (error) => toast.error(t(errorKey(error)), { description: error.message }),
  });
  return (
    <Button variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
      {check.isPending && <Spinner />}
      {t("home.fix.check")}
    </Button>
  );
}

function FixButton({ fix, onPickVoice }: { readonly fix: Fix; readonly onPickVoice: () => void }) {
  const t = useT();
  switch (fix.kind) {
    case "link":
      return (
        <Button variant="outline" size="sm" asChild>
          <Link to={fix.to}>{t(fix.label)}</Link>
        </Button>
      );
    case "pick-voice":
      return (
        <Button variant="outline" size="sm" onClick={onPickVoice}>
          {t("home.fix.pickVoice")}
        </Button>
      );
    case "check":
      return <CheckButton provider={fix.provider} />;
    case "restart":
      return <RestartButton label="home.fix.restart" variant="outline" />;
  }
}

function Row({ item, onPickVoice }: { readonly item: Item; readonly onPickVoice: () => void }) {
  const t = useT();
  const { icon: Icon, className } = TONES[item.tone];
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm">{t(item.text, item.vars)}</span>
          {item.detail && (
            <span className="break-words font-mono text-muted-foreground text-xs">
              {item.detail}
            </span>
          )}
        </div>
      </div>
      {item.fix && (
        <div className="shrink-0 pl-6.5 sm:pl-0">
          <FixButton fix={item.fix} onPickVoice={onPickVoice} />
        </div>
      )}
    </li>
  );
}

/** What calls and builds need, each with the action that fixes it. */
export function ReadinessList({
  status,
  onPickVoice,
}: {
  readonly status: Status;
  readonly onPickVoice: () => void;
}) {
  const lang = useLang();
  const formats = useMemo(() => formatsFor(lang), [lang]);
  return (
    <ul className="divide-y">
      {readiness(status, formats).map((item) => (
        <Row key={item.id} item={item} onPickVoice={onPickVoice} />
      ))}
    </ul>
  );
}
