// Settings' Skills: the owner's skills, from Eidolon's skills folder and the folder their agents
// share, each with where it is from and its switch, and a new one written into Eidolon's. A task's
// own folder's skills are that task's, and never listed here.

import type { MessageDescriptor } from "@lingui/core";
import { msg, ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  PlusIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { QuietBadge } from "@/components/quiet-badge";
import { SectionCard } from "@/components/section-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { call, type SkillOrigin, type SkillsResponse, type SkillView } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import { NewSkillDialog } from "./new-skill-dialog";
import { SKILL_FILTERS, type SkillFilter, visibleSkills } from "./skills";

const skillsQuery = queryOptions({
  queryKey: ["assistant", "skills"],
  queryFn: ({ signal }) => call("GET /api/local/skills", { signal }),
  // Skill folders change outside the app.
  refetchOnWindowFocus: true,
});

const SOURCE_LABELS: Readonly<Record<SkillOrigin, MessageDescriptor>> = {
  eidolon: msg`Eidolon`,
  shared: msg`Shared`,
};

const FILTER_LABELS: Readonly<Record<SkillFilter, MessageDescriptor>> = {
  all: msg`All Skills`,
  eidolon: msg`Eidolon's Folder`,
  shared: msg`Shared Folder`,
  off: msg`Switched Off`,
};

function SkillRow({
  skill,
  busy,
  onSwitch,
}: {
  readonly skill: SkillView;
  readonly busy: boolean;
  readonly onSwitch: (enabled: boolean) => void;
}) {
  const { t } = useLingui();
  const { name, description, folder, linksTo, shadowedBy, problems } = skill;
  const notes = [
    ...(shadowedBy === undefined
      ? []
      : [
          {
            text: t`Hidden by the skill of the same name in ${ph({ shadowedBy })}.`,
            tone: "muted",
          },
        ]),
    ...(skill.unlisted === true
      ? [
          {
            text: t`Tasks' list of skills is full without it, so only naming it to her reaches a task. Switch off skills tasks don't need.`,
            tone: "warning",
          },
        ]
      : []),
    ...problems.map((text) => ({ text, tone: "warning" })),
  ];
  const off = !skill.enabled || shadowedBy !== undefined;
  return (
    <li
      data-skill={name}
      data-source={skill.source}
      className="flex gap-3.5 rounded-xl border bg-card px-4 py-3.5 transition-colors hover:bg-muted/25"
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground [&_svg]:size-4",
          off && "opacity-60",
        )}
      >
        <ScrollTextIcon />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-x-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("wrap-anywhere font-medium", off && "text-muted-foreground")}>
              {name}
            </span>
            <QuietBadge>{t(SOURCE_LABELS[skill.source])}</QuietBadge>
            {skill.onlyWhenNamed === true && <QuietBadge>{t`Only When Named`}</QuietBadge>}
          </div>
          {/* Right to left, so a long path loses its start and keeps the skill's own folder. */}
          <span
            dir="rtl"
            className="hidden max-w-72 truncate font-mono text-muted-foreground text-xs sm:block"
            title={linksTo === undefined ? folder : `${folder} → ${linksTo}`}
          >
            <bdi dir="ltr">{folder}</bdi>
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-x-4">
          <p className="min-w-0 flex-1 truncate text-muted-foreground text-sm" title={description}>
            {description}
          </p>
          {shadowedBy === undefined && (
            <Switch
              checked={skill.enabled}
              disabled={busy}
              onCheckedChange={onSwitch}
              aria-label={t`Let Tasks Use ${ph({ name })}`}
            />
          )}
        </div>
        <p className="wrap-anywhere font-mono text-muted-foreground text-xs sm:hidden">{folder}</p>
        {(linksTo !== undefined || notes.length > 0) && (
          <div className="flex flex-col gap-0.5 pt-0.5 text-xs">
            {linksTo !== undefined && (
              <p className="wrap-anywhere text-muted-foreground">
                {t`Links to`} <span className="font-mono">{linksTo}</span>
              </p>
            )}
            {notes.map(({ text, tone }) => (
              <p
                key={text}
                className={cn(
                  "wrap-anywhere",
                  tone === "warning" ? "text-warning" : "text-muted-foreground",
                )}
              >
                {text}
              </p>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/** SKILL.md files and folders the scan left out, and why, in the server's English. */
function Skipped({ skipped }: { readonly skipped: SkillsResponse["skipped"] }) {
  const { t } = useLingui();
  return (
    <Collapsible className="overflow-hidden rounded-xl border">
      <CollapsibleTrigger className="group flex w-full items-center gap-3 px-4 py-3 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">
        <TriangleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="flex-1 font-medium">
          {t`${plural(ph({ count: skipped.length }), { one: `# skill couldn't be loaded`, other: `# skills couldn't be loaded` })}`}
        </span>
        <ChevronDownIcon
          className="size-4 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-2.5 border-t bg-muted/50 px-4 py-3.5 text-xs leading-5">
          {skipped.map(({ path, message }) => (
            <li key={`${path}\n${message}`} className="flex flex-col">
              <span className="wrap-anywhere font-mono">{path}</span>
              <span className="text-muted-foreground">{message}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RowSkeletons() {
  return (
    <div className="flex flex-col gap-2.5">
      {["a", "b", "c"].map((key) => (
        <div key={key} className="flex gap-3.5 rounded-xl border px-4 py-3.5">
          <Skeleton className="size-8 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3.5 w-full max-w-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkillsCard() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const skills = useQuery(skillsQuery);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const change = useMutation({
    mutationFn: ({ name, enabled }: { readonly name: string; readonly enabled: boolean }) =>
      call("PUT /api/local/skills/:name", { params: { name }, body: { enabled } }),
    onSuccess: (data) => queryClient.setQueryData(skillsQuery.queryKey, data),
    onError: (error) => {
      toastError(error);
      void queryClient.invalidateQueries({ queryKey: skillsQuery.queryKey });
    },
  });
  const data = skills.data;
  const shown = data === undefined ? [] : visibleSkills(data.skills, filter, search);
  const unlisted = data?.skills.filter((skill) => skill.unlisted === true).length ?? 0;
  const eidolon =
    data?.sources.find((source) => source.id === "eidolon")?.path ?? "~/.laplace/eidolon/skills";
  const shared = data?.sources.find((source) => source.id === "shared")?.path ?? "~/.agents/skills";
  return (
    <SectionCard
      title={t`Skills`}
      description={t`Instructions a task follows for one kind of work, such as your house style or how you ship a change. A task loads a skill when its work calls for it, or from its start when you name the skill to her. A task also finds the skills in its own folder's .agents/skills.`}
      action={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={skills.isFetching}
            onClick={() => void skills.refetch()}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={cn(skills.isFetching && "animate-spin")}
            />
            {t`Refresh`}
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <PlusIcon data-icon="inline-start" />
            {t`Add Skill`}
          </Button>
        </>
      }
      note={
        <span>
          {t`Eidolon's folder:`} <span className="font-mono text-xs">{eidolon}</span>
          <span aria-hidden className="mx-2">
            ·
          </span>
          {t`Shared folder:`} <span className="font-mono text-xs">{shared}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <InputGroup className="sm:max-w-sm">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t`Search skills`}
            aria-label={t`Search Skills`}
            autoComplete="off"
          />
        </InputGroup>
        <Select value={filter} onValueChange={(next) => setFilter(next as SkillFilter)}>
          <SelectTrigger className="w-full sm:w-44" aria-label={t`Show`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SKILL_FILTERS.map((each) => (
              <SelectItem key={each} value={each}>
                {t(FILTER_LABELS[each])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {skills.isPending ? (
        <RowSkeletons />
      ) : skills.isError ? (
        <ErrorAlert error={skills.error} />
      ) : (
        <>
          {skills.data.errors.map((error) => (
            <Alert key={error} variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>{t`Your switches can't be read`}</AlertTitle>
              <AlertDescription className="wrap-anywhere">{error}</AlertDescription>
            </Alert>
          ))}
          {unlisted > 0 && (
            <Alert>
              <TriangleAlertIcon className="text-warning" />
              <AlertTitle>{t`Tasks' list of skills is full`}</AlertTitle>
              <AlertDescription>
                {t`${plural(ph({ count: unlisted }), { one: `A task lists 150 skills, or about 4,500 tokens of them, at most, so # skill that is on is left out. Switch off skills tasks don't need.`, other: `A task lists 150 skills, or about 4,500 tokens of them, at most, so # skills that are on are left out. Switch off skills tasks don't need.` })}`}
              </AlertDescription>
            </Alert>
          )}
          {skills.data.skills.length === 0 ? (
            <EmptyState
              icon={<ScrollTextIcon />}
              title={t`No skills yet`}
              description={t`Write one here, or put a skill's folder, with its SKILL.md, in Eidolon's skills folder, or in the shared folder for your other agents too.`}
              action={
                <Button size="sm" onClick={() => setAdding(true)}>
                  <PlusIcon data-icon="inline-start" />
                  {t`Add Skill`}
                </Button>
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState icon={<SearchIcon />} title={t`No skills match.`} />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {shown.map((skill) => (
                <SkillRow
                  key={`${skill.source}\n${skill.folder}`}
                  skill={skill}
                  busy={change.isPending && change.variables?.name === skill.name}
                  onSwitch={(enabled) => change.mutate({ name: skill.name, enabled })}
                />
              ))}
            </ul>
          )}
          {skills.data.skipped.length > 0 && <Skipped skipped={skills.data.skipped} />}
        </>
      )}
      <NewSkillDialog
        open={adding}
        folder={eidolon}
        skills={data?.skills ?? []}
        onClose={() => setAdding(false)}
        onAdded={(added) => queryClient.setQueryData(skillsQuery.queryKey, added)}
      />
    </SectionCard>
  );
}
