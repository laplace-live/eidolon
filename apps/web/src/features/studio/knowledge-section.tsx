// Knowledge: her fact files, the index calls search, and how it is built and searched.

import { msg, ph, plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
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
import { COMMAND_LABELS } from "@/features/jobs/labels";
import { JobCard } from "@/features/jobs/parts";
import { jobsQuery, useStartJob } from "@/features/jobs/queries";
import type { FactFile, IndexTable, JobCommand, PersonaSummary } from "@/lib/api";
import { formatBytes, formatCount, formatDateTime } from "@/lib/format";
import { latestJob, type Outcome } from "@/lib/jobs";
import { statusQuery } from "@/lib/query";
import { useLang } from "@/locales/i18n";
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

const TABLE_NAMES = {
  persona_facts: msg`Facts`,
  stream_chunks: msg`Stream Archive`,
} satisfies Record<IndexTable["table"], unknown>;

/** The line beside "Index facts". */
function hintText(hint: ReturnType<typeof factsHint>): string {
  const count = hint.vars?.count ?? 0;
  switch (hint.key) {
    case "studio.facts.nothingMatched":
      return t`No file matches the patterns, so there is nothing to index.`;
    case "studio.facts.changedCount":
      return t`${plural(count, { one: "# file changed since the last index.", other: "# files changed since the last index." })}`;
    case "studio.facts.goneCount":
      return t`${plural(count, { one: "# file was removed since the last index.", other: "# files were removed since the last index." })}`;
    default:
      return t`Every file is indexed as it is now.`;
  }
}

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
  const { t } = useLingui();
  if (!file.matched) {
    return <QuietBadge>{t`Not indexed`}</QuietBadge>;
  }
  if (file.changed) {
    return (
      <Badge variant="outline" className="border-warning/40 font-normal text-warning">
        {t`Changed`}
      </Badge>
    );
  }
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <CheckIcon className="size-3.5" />
      {t`Indexed`}
    </span>
  );
}

function FactsCard({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
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
      {t`New File`}
    </Button>
  );

  return (
    <SectionCard
      title={t`Facts`}
      description={t`Fact files hold what she knows about herself, one fact per line. Indexing them uses the embedding API, which bills a little.`}
      // One New file button at a time: the empty state carries it while there are no files.
      action={files.length > 0 ? newFile("outline") : undefined}
      note={facts.data ? hintText(hint) : undefined}
      actions={
        <RunButton
          persona={persona.id}
          command="ingest-facts"
          label={t`Index Facts`}
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
            title={t`No fact files yet`}
            description={t`Add a .txt file of what she knows about herself, then index it. Files matching ${patterns} are indexed.`}
            action={newFile("default")}
          />
        ) : (
          <ListCard header={t`Indexed files match ${patterns}`}>
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
                      aria-label={t`Edit ${ph({ name: file.name })}`}
                      onClick={() => open({ kind: "file", name: file.name })}
                    >
                      <PencilIcon />
                      {t`Edit`}
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
          <AlertTitle>{t`${plural(ph({ count: state.gone.length }), { one: `Her index still has facts from # removed file`, other: `Her index still has facts from # removed files` })}`}</AlertTitle>
          <AlertDescription>
            <p>
              {state.matched > 0
                ? t`They were deleted, or no longer match the patterns. Index facts again so she forgets them:`
                : t`No file is left for indexing to read, and it keeps her old facts until it has one. Add a fact file, then index facts again so she forgets these:`}
            </p>
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
  const { t } = useLingui();
  const lang = useLang();
  const index = useQuery(personaQueries(persona.id).index);
  const builder = (table: IndexTable["table"]) => t(COMMAND_LABELS[BUILDS[table]]);
  if (index.isPending) return <Skeleton className="h-28 rounded-xl" />;
  if (index.isError) return <LoadError error={index.error} />;
  return (
    <>
      {index.data.tables.some((table) => table.stale) && (
        <p className="text-destructive text-sm">{t`A table built with another embedding model or size than the settings now name can't be searched. Run its job again.`}</p>
      )}
      <SectionCardTable
        columns={[
          { id: "table", label: t({ message: "Table", context: "index storage" }) },
          { id: "rows", label: t`Rows` },
          { id: "builtAt", label: t`Built` },
          { id: "model", label: t`Embedding Model` },
        ]}
        last
      >
        {index.data.tables.map((table) => (
          <TableRow key={table.table} className="hover:bg-transparent">
            <TableCell className="py-3">
              <div className="font-medium">{t(TABLE_NAMES[table.table])}</div>
              <div className="text-muted-foreground text-xs">
                {t`Built by ${ph({ job: builder(table.table) })}`}
              </div>
            </TableCell>
            <TableCell className="tabular-nums">
              {table.rows === null ? (
                <QuietBadge>{t`Not built`}</QuietBadge>
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
                {table.stale && <Badge variant="destructive">{t`Re-index needed`}</Badge>}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </SectionCardTable>
    </>
  );
}

function IndexCard({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
  const lang = useLang();
  const index = useQuery(personaQueries(persona.id).index);
  const { data: jobs } = useQuery(jobsQuery);
  const streamsJob = latestJob(jobs ?? [], persona.id, ["ingest-streams", "build-stream-catalog"]);
  const onEnded = useIngestEnded(persona.id);
  const running = streamsJob?.status === "running";
  const catalog = index.data?.catalogBuiltAt;

  return (
    <SectionCard
      title={t`Index`}
      description={t`What calls search: her facts and her stream archive. Each table is rebuilt by its own job.`}
      note={
        catalog === undefined
          ? undefined
          : catalog === null
            ? t`No stream catalog yet.`
            : t`Stream catalog built ${ph({ time: formatDateTime(catalog, lang) })}.`
      }
      actions={
        <>
          <RunButton
            persona={persona.id}
            command="build-stream-catalog"
            label={t`Rebuild Catalog`}
            running={running}
          />
          <RunButton
            persona={persona.id}
            command="ingest-streams"
            label={t`Index Streams`}
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
  const { t } = useLingui();
  return (
    <>
      <FactsCard persona={persona} />
      <IndexCard persona={persona} />
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.indexing}
        title={t`Indexing`}
        description={t`What the index jobs read: which of her fact files, the pattern that names her in them, and the scene types left out of her stream archive. Index again after a change.`}
      />
      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.search}
        title={t`Search`}
        description={t`How a call searches what she knows: how many candidates each index offers, the reranker that orders them, and the gate that skips the search when a turn isn't about her.`}
      />
    </>
  );
}
