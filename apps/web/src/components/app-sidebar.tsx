// The app's sidebar, as a desktop chat app keeps one: who calls reach, New Chat and the pages, the
// chats, then Settings. It collapses to icons, and is a sheet on a phone.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenIcon,
  HouseIcon,
  ListTodoIcon,
  PanelLeftOpenIcon,
  PhoneIcon,
  ReceiptIcon,
  SettingsIcon,
  SquarePenIcon,
  WorkflowIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Link, matchRoute, useLocation, useRouter } from "wouter";
import { AppMark } from "@/components/app-mark";
import { PersonaSwitcher } from "@/components/persona-switcher";
import { LanguageSwitch, ThemeMenu } from "@/components/preferences";
import { SubspaceSwitcher } from "@/components/subspace-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { NewChatMenu, SidebarChats } from "@/features/chats/chat-list";
import { chatsQuery } from "@/features/chats/queries";
import { tasksQuery } from "@/features/tasks/queries";
import { endedSince, tasksPoll, waitingCount } from "@/features/tasks/state";
import type { TaskStatus } from "@/lib/api";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";

/** How often the sidebar asks for the tasks while none is live: one may start in any chat. */
const TASKS_IDLE_POLL_MS = 30_000;

interface Page {
  readonly to: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly end?: boolean;
  /** Lit for every path under this one, not only its own. */
  readonly section?: string;
  /** Tasks waiting on the owner, beside Tasks. */
  readonly waiting?: number;
}

function lit(
  page: Pick<Page, "to" | "end" | "section">,
  pathname: string,
  parser: ReturnType<typeof useRouter>["parser"],
): boolean {
  if (page.section !== undefined) return pathname.startsWith(page.section);
  return matchRoute(parser, page.to, pathname, !page.end)[0];
}

/** The logo, home; collapsed, the logo opens the sidebar again. The desktop app's strip toggles it. */
function Brand() {
  const { t } = useLingui();
  const { toggleSidebar } = useSidebar();
  return (
    <div className="flex h-9 items-center gap-1">
      <Link
        to="/"
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 font-logo font-semibold text-xl outline-none ring-sidebar-ring focus-visible:ring-2 group-data-[collapsible=icon]:hidden"
      >
        <AppMark />
        <span className="truncate">LAPLACE Eidolon</span>
      </Link>
      <SidebarTrigger className="group-data-[collapsible=icon]:hidden shell:hidden" />
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={t`Expand Sidebar`}
        className="group/brand hidden size-8 items-center justify-center rounded-md outline-none ring-sidebar-ring hover:bg-sidebar-accent focus-visible:ring-2 group-data-[collapsible=icon]:flex"
      >
        <AppMark className="group-hover/brand:hidden group-focus-visible/brand:hidden" />
        <PanelLeftOpenIcon className="hidden size-4 group-hover/brand:block group-focus-visible/brand:block" />
      </button>
    </div>
  );
}

function PageItem({ page, current }: { readonly page: Page; readonly current: boolean }) {
  const { t } = useLingui();
  const waiting = page.waiting ?? 0;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={current} tooltip={page.label}>
        <Link to={page.to} aria-current={current ? "page" : undefined}>
          {page.icon}
          <span>{page.label}</span>
          {waiting > 0 && (
            <span
              data-waiting-count
              className="ml-auto min-w-5 rounded-full bg-warning/15 px-1.5 text-center font-medium text-warning text-xs tabular-nums"
            >
              <span aria-hidden>{waiting}</span>
              <span className="sr-only">{t`, ${ph({ count: waiting })} waiting for you`}</span>
            </span>
          )}
        </Link>
      </SidebarMenuButton>
      {waiting > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full bg-warning group-data-[collapsible=icon]:block"
        />
      )}
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const { t } = useLingui();
  const [pathname] = useLocation();
  const { parser } = useRouter();
  const queryClient = useQueryClient();
  const seenTasks = useRef<ReadonlyMap<string, TaskStatus>>(new Map());
  const { isMobile, state } = useSidebar();
  const { data: status } = useQuery(statusQuery);
  const assistant = status?.assistant.enabled === true;
  const tasks = useQuery({
    ...tasksQuery,
    enabled: assistant,
    refetchInterval: (read) => tasksPoll(read.state.data?.tasks, TASKS_IDLE_POLL_MS),
  }).data?.tasks;
  // A task that ends starts her report turn in its chat; refresh the list so active polling starts.
  useEffect(() => {
    if (tasks === undefined) return;
    if (endedSince(seenTasks.current, tasks).length > 0) {
      void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
    }
    seenTasks.current = new Map(tasks.map((task) => [task.id, task.status]));
  }, [tasks, queryClient]);
  // The studio opens on the active persona; it stays lit on any persona's.
  const pages: readonly Page[] = [
    { to: "/", label: t`Home`, icon: <HouseIcon />, end: true },
    { to: "/call", label: t`Call`, icon: <PhoneIcon /> },
    ...(status
      ? [
          {
            to: studioPath(status.persona.id),
            label: t`Studio`,
            icon: <BookOpenIcon />,
            section: "/personas/",
          },
        ]
      : []),
    ...(assistant
      ? [
          {
            to: "/tasks",
            label: t`Tasks`,
            icon: <ListTodoIcon />,
            waiting: waitingCount(tasks ?? []),
          },
        ]
      : []),
    { to: "/jobs", label: t`Jobs`, icon: <WorkflowIcon /> },
    { to: "/usage", label: t`Usage`, icon: <ReceiptIcon /> },
  ];
  const settings = lit({ to: "/settings" }, pathname, parser);
  // Collapsed to icons, its menus open beside the rail rather than over the page.
  const side = isMobile || state === "expanded" ? "bottom" : "right";

  return (
    // On the frame's ground, which the page's card borders; in the desktop app below the strip.
    <Sidebar
      collapsible="icon"
      className="group-data-[side=left]:border-r-0 shell:top-(--strip) shell:h-auto"
    >
      <SidebarHeader>
        <Brand />
        <SubspaceSwitcher side={side} />
        <PersonaSwitcher side={side} />
      </SidebarHeader>
      <nav aria-label={t`Main`} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent className="group-data-[collapsible=icon]:overflow-auto">
          <SidebarGroup>
            <SidebarMenu className="gap-0.5">
              <SidebarMenuItem>
                <NewChatMenu side={side} align="start">
                  {({ pending, disabled }) => (
                    <SidebarMenuButton tooltip={t`New Chat`} disabled={disabled}>
                      {pending ? <Spinner /> : <SquarePenIcon />}
                      <span>{t`New Chat`}</span>
                    </SidebarMenuButton>
                  )}
                </NewChatMenu>
              </SidebarMenuItem>
              {pages.map((page) => (
                <PageItem key={page.to} page={page} current={lit(page, pathname, parser)} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarChats />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
              <SidebarMenuButton
                asChild
                isActive={settings}
                tooltip={t`Settings`}
                className="min-w-0 flex-1"
              >
                <Link to="/settings" aria-current={settings ? "page" : undefined}>
                  <SettingsIcon />
                  <span>{t`Settings`}</span>
                </Link>
              </SidebarMenuButton>
              <LanguageSwitch compact />
              <ThemeMenu side={side} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </nav>
      <SidebarRail />
    </Sidebar>
  );
}
