// The header's persona menu: who calls reach, switched in place. In a studio it follows the switch
// to the same section of the newly active persona's.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useMatch, useNavigate } from "react-router";
import { toast } from "sonner";
import { PersonaAvatar } from "@/components/avatar";
import { personasQuery } from "@/components/settings-form/queries";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { NewPersonaDialog } from "@/features/setup/new-persona";
import { activatePersona, refreshPersonas } from "@/features/setup/personas";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";

export function PersonaSwitcher() {
  const t = useT();
  const navigate = useNavigate();
  const studio = useMatch("/personas/:id/:tab?");
  const queryClient = useQueryClient();
  const status = useQuery(statusQuery);
  const personas = useQuery(personasQuery);
  const [creating, setCreating] = useState(false);
  // The dialog opens once the menu has closed: open together, the two focus traps fight, and the
  // first field loses focus at once, which shows its error before anything was typed.
  const openingDialog = useRef(false);

  const activate = useMutation({
    mutationFn: activatePersona,
    onSuccess: async (response, id) => {
      queryClient.setQueryData(personasQuery.queryKey, response);
      const chosen = response.personas.find((persona) => persona.id === id);
      toast.success(t("common.switcher.activated", { name: chosen?.name ?? id }));
      if (studio && studio.params.id !== id) navigate(studioPath(id, studio.params.tab));
      await refreshPersonas(queryClient);
    },
    onError: toastError,
  });

  const activeId = personas.data?.active ?? status.data?.persona.id;
  const list = personas.data?.personas ?? [];
  const active = list.find((persona) => persona.id === activeId) ?? status.data?.persona;
  if (!active || activeId === undefined) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="min-w-0 max-w-[60vw] gap-2 px-1.5 sm:max-w-64"
            aria-label={t("common.switcher.label", { name: active.name })}
          >
            <PersonaAvatar persona={active} size="xs" />
            <span className="truncate font-medium">{active.name}</span>
            {activate.isPending ? (
              <Spinner className="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64"
          onCloseAutoFocus={(event) => {
            if (!openingDialog.current) return;
            openingDialog.current = false;
            event.preventDefault();
            setCreating(true);
          }}
        >
          <DropdownMenuLabel>{t("common.switcher.heading")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={activeId}
            onValueChange={(id) => {
              if (id !== activeId) activate.mutate(id);
            }}
          >
            {list.map((persona) => (
              <DropdownMenuRadioItem
                key={persona.id}
                value={persona.id}
                disabled={activate.isPending}
                className="gap-2 py-1.5"
              >
                <PersonaAvatar persona={persona} size="xs" />
                <span className="truncate">{persona.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              openingDialog.current = true;
            }}
          >
            <PlusIcon />
            {t("common.switcher.new")}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={studioPath(activeId)}>
              <BookOpenIcon />
              {t("common.switcher.studio")}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewPersonaDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(created) => navigate(studioPath(created.id, "identity"))}
      />
    </>
  );
}
