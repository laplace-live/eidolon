import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { PersonaAvatar } from "@/components/avatar";
import { ErrorAlert } from "@/components/error-alert";
import { personasQuery } from "@/components/settings-form/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { activatePersona, refreshPersonas } from "@/features/setup/personas";
import type { PersonaSummary } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";
import { cn } from "@/lib/utils";

const CARD = "relative flex min-h-24 items-center gap-4 rounded-xl border p-4 transition-colors";

function PersonaCard({
  persona,
  active,
  activating,
  locked,
  onActivate,
}: {
  readonly persona: PersonaSummary;
  readonly active: boolean;
  /** This one is being made active. */
  readonly activating: boolean;
  /** Another switch is under way, or a call holds the active one. */
  readonly locked: boolean;
  readonly onActivate: () => void;
}) {
  const t = useT();
  return (
    <li className={cn(CARD, "bg-card hover:bg-muted/40")}>
      <PersonaAvatar persona={persona} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={studioPath(persona.id)}
            className="truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
          >
            {persona.name}
          </Link>
          {active && <Badge className="shrink-0">{t("home.personas.active")}</Badge>}
          {persona.template && (
            <Badge variant="outline" className="shrink-0">
              {t("home.personas.builtIn")}
            </Badge>
          )}
        </div>
        <span className="truncate font-mono text-muted-foreground text-xs">{persona.id}</span>
      </div>
      {!active && (
        <Button
          variant="outline"
          size="sm"
          className="relative z-10"
          disabled={locked}
          onClick={onActivate}
        >
          {activating && <Spinner />}
          {t("home.personas.activate")}
        </Button>
      )}
    </li>
  );
}

/** Every persona: a click opens her studio, and Activate makes her the one calls reach. */
export function PersonaGrid({
  live,
  onNew,
}: {
  /** A call is in progress, so the active persona can't change. */
  readonly live: boolean;
  readonly onNew: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const personas = useQuery(personasQuery);
  const activate = useMutation({
    mutationFn: activatePersona,
    onSuccess: async (response, id) => {
      queryClient.setQueryData(personasQuery.queryKey, response);
      const chosen = response.personas.find((persona) => persona.id === id);
      toast.success(t("home.personas.activated", { name: chosen?.name ?? id }));
      await refreshPersonas(queryClient);
    },
    onError: toastError,
  });

  if (personas.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }
  if (personas.isError) return <ErrorAlert error={personas.error} />;

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {personas.data.personas.map((persona) => (
        <PersonaCard
          key={persona.id}
          persona={persona}
          active={persona.id === personas.data.active}
          activating={activate.isPending && activate.variables === persona.id}
          locked={live || activate.isPending}
          onActivate={() => activate.mutate(persona.id)}
        />
      ))}
      <li className="flex">
        <button
          type="button"
          onClick={onNew}
          className={cn(
            CARD,
            "w-full border-dashed text-left text-muted-foreground outline-none hover:bg-muted/40 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
          )}
        >
          <span className="flex size-16 shrink-0 items-center justify-center rounded-full border border-dashed">
            <PlusIcon className="size-5" />
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-medium text-foreground">{t("home.personas.new")}</span>
            <span className="text-sm">{t("home.personas.newBody")}</span>
          </span>
        </button>
      </li>
    </ul>
  );
}
