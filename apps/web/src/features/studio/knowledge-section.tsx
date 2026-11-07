// Knowledge: her fact files, the index calls search, and how it is built and searched.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, FilePlusIcon, FileTextIcon, PencilIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ListCard, ListRow } from "@/components/list";
import { QuietBadge } from "@/components/quiet-badge";
import { SectionCard, SectionCardTable } from "@/components/section-card";
import { SettingsCard } from "@/components/settings-form/settings-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { JobCard } from "@/features/jobs/parts";
import { jobsQuery, useStartJob } from "@/features/jobs/queries";
import type { FactFile, IndexTable, JobCommand, PersonaSummary } from "@/lib/api";
import { formatBytes, formatCount, formatDateTime } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { latestJob, type Outcome } from "@/lib/jobs";
import { statusQuery } from "@/lib/query";
import { FactSheet, type FactTarget } from "./facts-editor";
import { factsHint, factsState, wasIndexed } from "./knowledge";
import { LoadError } from "./parts";
import { personaQueries } from "./queries";
import { CARD_PATHS } from "./sections";
import { LeaveDialog } from "./text-editor";

/** Which job rebuilds each table. */
const BUILDS: Record<IndexTable["table"], JobCommand> = {
  persona_facts: "ingest-facts",
  stream_chunks: "ingest-streams",
};

/** Refreshes what a finished ingest changed. */
function useIngestEnded(persona: string) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    const queries = personaQueries(persona);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queries.facts.queryKey, exact: true }),
      queryClient.invalidateQueries({ queryKey: queries.index.queryKey }),
      queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
    ]);
  }, [queryClient, persona]);
}

function RunButton({
  persona,
  command,
  label,
  running,
  variant = "outline",
}: {
  readonly persona: string;
  readonly command: "ingest-facts" | "ingest-streams" | "build-stream-catalog";
  readonly label: string;
  readonly running: boolean;
  readonly variant?: "default" | "outline";
}) {
  const start = useStartJob();
  return (
    <Button
      variant={variant}
      disabled={running || start.isPending}
      onClick={() => start.mutate({ command, persona })}
    >
      {label}
    </Button>
  );
}

function FactState({ file }: { readonly file: FactFile }) {
  const t = useT();
  if (!file.matched) {
    return <QuietBadge>{t("studio.facts.notMatched")}</QuietBadge>;
  }
  if (file.changed) {
    return (
      <Badge variant="outline" className="border-warning/40 font-normal text-warning">
        {t("studio.facts.changed")}
      </Badge>
    );
  }
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <CheckIcon className="size-3.5" />
      {t("studio.facts.indexed")}
    </span>
  );
}

function FactsCard({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const lang = useLang();
  const facts = useQuery(personaQueries(persona.id).facts);
  const index = useQuery(personaQueries(persona.id).index);
  const { data: jobs } = useQuery(jobsQuery);
  const factsJob = latestJob(jobs ?? [], persona.id, ["ingest-facts"]);
  const ingestEnded = useIngestEnded(persona.id);
  const [target, setTarget] = useState<FactTarget | null>(null);
  const [dirty, setDirty] = useState(false);
  // A switch the viewer asked for while the open file has unsaved edits, waiting for an answer.
  const [pending, setPending] = useState<{ readonly next: FactTarget | null } | null>(null);
  // Files deleted here that the index held, until an ingest drops them.
  const [deleted, setDeleted] = useState<readonly string[]>([]);

  function open(next: FactTarget | null) {
    if (dirty) setPending({ next });
    else setTarget(next);
  }

  function settle(next: FactTarget | null) {
    setDirty(false);
    setTarget(next);
  }

  const onEnded = useCallback(
    (outcome: Outcome) => {
      if (outcome === "succeeded") setDeleted([]);
      ingestEnded();
    },
    [ingestEnded],
  );

  const files = facts.data?.files ?? [];
  const state = factsState({ files, removed: facts.data?.removed ?? [] }, deleted);
  const hint = factsHint(state);
  const factsTable = index.data?.tables.find((table) => table.table === "persona_facts");
  const patterns = facts.data?.patterns.join(", ") || "—";

  function onDeleted(name: string) {
    const file = files.find((entry) => entry.name === name);
    if (file && wasIndexed(file, factsTable)) setDeleted((names) => [...names, name]);
    settle(null);
  }

  const newFile = (variant: "default" | "outline") => (
    <Button variant={variant} onClick={() => open({ kind: "new" })}>
      <FilePlusIcon />
      {t("studio.facts.new")}
    </Button>
  );

  return (
    <SectionCard
      title={t("studio.facts.title")}
      description={t("studio.facts.description")}
      // One New file button at a time: the empty state carries it while there are no files.
      action={files.length > 0 ? newFile("outline") : undefined}
      note={facts.data ? t(hint.key, hint.vars) : undefined}
      actions={
        <RunButton
          persona={persona.id}
          command="ingest-facts"
          label={t("studio.facts.ingest")}
          running={factsJob?.status === "running"}
          variant="default"
        />
      }
    >
      {facts.isPending && <Skeleton className="h-32 rounded-xl" />}
      {facts.isError && <LoadError error={facts.error} />}
      {facts.data &&
        (files.length === 0 ? (
          <EmptyState
            icon={<FileTextIcon />}
            title={t("studio.facts.emptyTitle")}
            description={t("studio.facts.emptyBody", { patterns })}
            action={newFile("default")}
          />
        ) : (
          <ListCard header={t("studio.facts.patterns", { patterns })}>
            {files.map((file) => (
              <ListRow
                key={file.name}
                leading={
                  <span className="flex size-9 items-center justify-center rounded-lg border bg-muted/40">
                    <FileTextIcon className="size-4" />
                  </span>
                }
                title={<span className="block truncate">{file.name}</span>}
                description={`${formatBytes(file.size, lang)} · ${formatDateTime(file.mtime, lang)}`}
                trailing={
                  <>
                    <FactState file={file} />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("studio.facts.editName", { name: file.name })}
                      onClick={() => open({ kind: "file", name: file.name })}
                    >
                      <PencilIcon />
                      {t("studio.facts.edit")}
                    </Button>
                  </>
                }
              />
            ))}
          </ListCard>
        ))}
      {state.gone.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>{t("studio.facts.goneTitle", { count: state.gone.length })}</AlertTitle>
          <AlertDescription>
            <p>{t(state.matched > 0 ? "studio.facts.goneBody" : "studio.facts.goneEmpty")}</p>
            <p className="break-all font-mono text-xs">{state.gone.join(", ")}</p>
          </AlertDescription>
        </Alert>
      )}
      {factsJob && <JobCard key={factsJob.id} job={factsJob} onEnded={onEnded} />}
      <FactSheet
        persona={persona.id}
        target={target}
        existing={files.map((file) => file.name)}
        onClose={() => open(null)}
        onCreated={() => settle(null)}
        onDeleted={onDeleted}
        onDirtyChange={setDirty}
      />
      <LeaveDialog
        open={pending !== null}
        onStay={() => setPending(null)}
        onLeave={() => {
          settle(pending?.next ?? null);
          setPending(null);
        }}
      />
    </SectionCard>
  );
}

function IndexTables({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const lang = useLang();
  const index = useQuery(personaQueries(persona.id).index);
  if (index.isPending) return <Skeleton className="h-28 rounded-xl" />;
  if (index.isError) return <LoadError error={index.error} />;
  return (
    <>
      {index.data.tables.some((table) => table.stale) && (
        <p className="text-destructive text-sm">{t("studio.index.staleHelp")}</p>
      )}
      <SectionCardTable
        columns={(["table", "rows", "builtAt", "model"] as const).map((column) => ({
          id: column,
          label: t(`studio.index.${column}`),
        }))}
        last
      >
        {index.data.tables.map((table) => (
          <TableRow key={table.table} className="hover:bg-transparent">
            <TableCell className="py-3">
              <div className="font-medium">{t(`studio.index.${table.table}`)}</div>
              <div className="text-muted-foreground text-xs">
                {t("studio.index.builtBy", {
                  job: t(`jobs.command.${BUILDS[table.table]}`),
                })}
              </div>
            </TableCell>
            <TableCell className="tabular-nums">
              {table.rows === null ? (
                <QuietBadge>{t("studio.index.notBuilt")}</QuietBadge>
              ) : (
                formatCount(table.rows, lang)
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {table.builtAt === null ? "—" : formatDateTime(table.builtAt, lang)}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-2">
                {table.model !== null ? (
                  <span className="font-mono text-muted-foreground text-xs">
                    {table.model}
                    {table.dim !== null && ` · ${table.dim}`}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
                {table.stale && <Badge variant="destructive">{t("studio.index.stale")}</Badge>}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </SectionCardTable>
    </>
  );
}

function IndexCard({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const lang = useLang();
  const index = useQuery(personaQueries(persona.id).index);
  const { data: jobs } = useQuery(jobsQuery);
  const streamsJob = latestJob(jobs ?? [], persona.id, ["ingest-streams", "build-stream-catalog"]);
  const onEnded = useIngestEnded(persona.id);
  const running = streamsJob?.status === "running";
  const catalog = index.data?.catalogBuiltAt;

  return (
    <SectionCard
      title={t("studio.index.title")}
      description={t("studio.index.description")}
      note={
        catalog === undefined
          ? undefined
          : catalog === null
            ? t("studio.index.noCatalog")
            : t("studio.index.catalog", { time: formatDateTime(catalog, lang) })
      }
      actions={
        <>
          <RunButton
            persona={persona.id}
            command="build-stream-catalog"
            label={t("studio.index.buildCatalog")}
            running={running}
          />
          <RunButton
            persona={persona.id}
            command="ingest-streams"
            label={t("studio.index.ingestStreams")}
            running={running}
          />
        </>
      }
    >
      {streamsJob && <JobCard key={streamsJob.id} job={streamsJob} onEnded={onEnded} />}
      <IndexTables persona={persona} />
    </SectionCard>
  );
}

export function KnowledgeSection({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  return (
    <>
      <FactsCard persona={persona} />
      <IndexCard persona={persona} />
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.indexing}
        title={t("studio.indexing.title")}
        description={t("studio.indexing.description")}
      />
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.search}
        title={t("studio.search.title")}
        description={t("studio.search.description")}
      />
    </>
  );
}
