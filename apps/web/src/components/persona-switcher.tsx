// The sidebar's persona menu: who calls reach, switched in place. In a studio it follows the switch
// to the same section of the newly active persona's.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useMatch, useNavigate } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { personasQuery } from "@/components/settings-form/queries";
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
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useCallPresence } from "@/features/call/call-context";
import { NewPersonaDialog } from "@/features/setup/new-persona";
import { useActivatePersona } from "@/features/setup/personas";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";

export function PersonaSwitcher({ side }: { readonly side: "bottom" | "right" }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const studio = useMatch("/personas/:id/:tab?");
  const status = useQuery(statusQuery);
  const personas = useQuery(personasQuery);
  const { up } = useCallPresence();
  const [creating, setCreating] = useState(false);
  // The dialog opens once the menu has closed: open together, the two focus traps fight, and the
  // first field loses focus at once, which shows its error before anything was typed.
  const openingDialog = useRef(false);

  const activate = useActivatePersona((id) => {
    if (studio && studio.params.id !== id) navigate(studioPath(id, studio.params.tab));
  });

  // Status first: Home polls it, so it learns of a switch another tab made; the list is not.
  const activeId = status.data?.persona.id ?? personas.data?.active;
  const list = personas.data?.personas ?? [];
  const active = list.find((persona) => persona.id === activeId) ?? status.data?.persona;
  if (!active || activeId === undefined) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                aria-label={t`Active Persona: ${ph({ name: active.name })}`}
              >
                <PersonaAvatar persona={active} size="sm" />
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate font-medium">{active.name}</span>
                  <span className="truncate text-sidebar-foreground/60 text-xs">
                    {t`Active Persona`}
                  </span>
                </span>
                {activate.isPending ? (
                  <Spinner className="text-sidebar-foreground/60" />
                ) : (
                  <ChevronsUpDownIcon className="text-sidebar-foreground/60" />
                )}
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={side}
              align="start"
              className="w-64"
              onCloseAutoFocus={(event) => {
                if (!openingDialog.current) return;
                openingDialog.current = false;
                event.preventDefault();
                setCreating(true);
              }}
            >
              <DropdownMenuLabel>{t`Personas`}</DropdownMenuLabel>
              {up && (
                <p className="px-2 pb-1.5 text-muted-foreground text-xs">
                  {t`A call is in progress: switch personas after it ends.`}
                </p>
              )}
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
                    disabled={activate.isPending || up}
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
                {t`New Persona`}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to={studioPath(activeId)}>
                  <BookOpenIcon />
                  {t`Open the Studio`}
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <NewPersonaDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(created) => navigate(studioPath(created.id, "identity"))}
      />
    </>
  );
}
