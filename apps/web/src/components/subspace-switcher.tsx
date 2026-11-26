import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDownIcon, MonitorIcon, OrbitIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "wouter";
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
import { AddSubspaceServerDialog } from "@/features/subspace/add-server-dialog";
import {
  activeSubspaceServer,
  SUBSPACE_CONNECTION_DOT,
  subspaceQuery,
  useSwitchSubspaceHost,
} from "@/features/subspace/queries";

const LOCAL_HOST = "__local__";

export function SubspaceSwitcher({ side }: { readonly side: "bottom" | "right" }) {
  const { t } = useLingui();
  const subspace = useQuery(subspaceQuery);
  const { up } = useCallPresence();
  const switching = useSwitchSubspaceHost();
  const [adding, setAdding] = useState(false);
  // Defer opening the dialog until the menu finishes closing so focus traps don't collide.
  const openingDialog = useRef(false);

  const state = subspace.data;
  if (!state || (state.servers.length === 0 && state.activeHostId === null)) return null;

  const activeServer = activeSubspaceServer(state);
  const currentValue = activeServer?.id ?? LOCAL_HOST;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                data-subspace-switcher
                className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                aria-label={
                  activeServer
                    ? t`Active Subspace Server: ${ph({ name: activeServer.name })}`
                    : t`Active Subspace Server: This Computer`
                }
              >
                <span
                  className={
                    activeServer
                      ? "flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary"
                      : "flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground"
                  }
                >
                  {activeServer ? (
                    <OrbitIcon className="size-4" />
                  ) : (
                    <MonitorIcon className="size-4" />
                  )}
                </span>
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate font-medium">
                    {activeServer ? activeServer.name : t`This Computer`}
                  </span>
                  <span className="truncate text-sidebar-foreground/60 text-xs">
                    {activeServer ? t`Subspace` : t`Local Server`}
                  </span>
                </span>
                {switching.isPending ? (
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
                setAdding(true);
              }}
            >
              <DropdownMenuLabel>{t`Subspace`}</DropdownMenuLabel>
              {up && (
                <p className="px-2 pb-1.5 text-muted-foreground text-xs">
                  {t`A call is in progress: switch servers after it ends.`}
                </p>
              )}
              <DropdownMenuRadioGroup
                value={currentValue}
                onValueChange={(next) => {
                  const targetId = next === LOCAL_HOST ? null : next;
                  if (targetId !== state.activeHostId) switching.mutate(targetId);
                }}
              >
                <DropdownMenuRadioItem
                  value={LOCAL_HOST}
                  disabled={switching.isPending || up}
                  className="gap-2 py-1.5"
                >
                  <MonitorIcon className="size-4 shrink-0" />
                  <span className="truncate">{t`This Computer`}</span>
                </DropdownMenuRadioItem>
                {state.servers.map((server) => (
                  <DropdownMenuRadioItem
                    key={server.id}
                    value={server.id}
                    disabled={switching.isPending || up}
                    className="gap-2 py-1.5"
                  >
                    <OrbitIcon className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{server.name}</span>
                    <span
                      aria-hidden
                      className={`size-1.5 shrink-0 rounded-full ${SUBSPACE_CONNECTION_DOT[server.connectionState]}`}
                    />
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
                {t`Pair a Server`}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/settings?tab=subspace">
                  <SettingsIcon />
                  {t`Subspace Settings`}
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <AddSubspaceServerDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}
