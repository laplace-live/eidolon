import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLinesIcon, BookOpenIcon, PhoneIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { ErrorAlert } from "@/components/error-alert";
import { personasQuery } from "@/components/settings-form/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { NewPersonaDialog } from "@/features/setup/new-persona";
import { activatePersona, refreshPersonas } from "@/features/setup/personas";
import type { Status } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { MemoryPanel } from "./memory-panel";
import { ReadinessList } from "./readiness-list";
import { VoiceDialog } from "./voice-dialog";

/** Status is cheap and never waits on a remote probe, so home can poll it. */
const POLL_MS = 10_000;

function PersonaSwitch({ status }: { readonly status: Status }) {
  const t = useT();
  const queryClient = useQueryClient();
  const personas = useQuery(personasQuery);
  const change = useMutation({
    mutationFn: activatePersona,
    onSuccess: () => refreshPersonas(queryClient),
    onError: toastError,
  });
  const list = personas.data?.personas ?? [];
  if (list.length < 2) return null;
  const live = status.activeCalls > 0;
  return (
    <Select
      value={status.persona.id}
      onValueChange={(id) => change.mutate(id)}
      disabled={live || change.isPending}
    >
      <SelectTrigger className="w-full sm:w-56" aria-label={t("home.persona.switch")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {list.map((persona) => (
          <SelectItem key={persona.id} value={persona.id}>
            {persona.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Component() {
  const t = useT();
  const status = useQuery({ ...statusQuery, refetchInterval: POLL_MS });
  const [pickingVoice, setPickingVoice] = useState(false);
  const [creating, setCreating] = useState(false);

  if (status.isPending) return <Skeleton className="h-96 w-full" />;
  if (status.isError) {
    return <ErrorAlert error={status.error} />;
  }

  const { persona } = status.data;
  const voiceFromEnv = persona.voice.source === "env";
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <PersonaAvatar persona={persona} size="xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-sm">{t("home.persona.active")}</span>
            <h1 className="truncate font-heading font-semibold text-3xl">{persona.name}</h1>
            <code className="text-muted-foreground text-xs">{persona.id}</code>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" asChild>
              <Link to="/call">
                <PhoneIcon />
                {t("home.call", { name: persona.shortName || persona.name })}
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to={studioPath(persona.id, "identity")}>
                <BookOpenIcon />
                {t("home.studio")}
              </Link>
            </Button>
            {!voiceFromEnv && (
              <Button size="lg" variant="outline" onClick={() => setPickingVoice(true)}>
                <AudioLinesIcon />
                {t("home.voice.change")}
              </Button>
            )}
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <PersonaSwitch status={status.data} />
        <Button variant="ghost" onClick={() => setCreating(true)}>
          <PlusIcon />
          {t("home.persona.new")}
        </Button>
        {status.data.activeCalls > 0 && (
          <span className="text-muted-foreground text-sm">{t("home.persona.inCall")}</span>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("home.ready.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ReadinessList status={status.data} onPickVoice={() => setPickingVoice(true)} />
        </CardContent>
      </Card>

      <MemoryPanel persona={persona} memory={status.data.memory} />

      <p className="text-muted-foreground text-xs">
        {t("home.version", { version: status.data.version })}
      </p>

      <VoiceDialog
        persona={persona}
        current={persona.voice.id}
        open={pickingVoice}
        onOpenChange={setPickingVoice}
      />
      <NewPersonaDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
