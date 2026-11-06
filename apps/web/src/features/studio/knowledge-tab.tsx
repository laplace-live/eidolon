import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  FilePlusIcon,
  PencilIcon,
  PlayIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { SettingsForm } from "@/components/settings-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { JobCard } from "@/features/jobs/parts";
import { jobsQuery, useStartJob } from "@/features/jobs/queries";
import type { IndexTable, JobCommand, PersonaSummary } from "@/lib/api";
import { formatBytes, formatCount, formatDateTime } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { latestJob, type Outcome } from "@/lib/jobs";
import { statusQuery } from "@/lib/query";
import { FactEditor, type FactTarget } from "./facts-editor";
import { factsHint, factsState, wasIndexed } from "./knowledge";
import { LoadError, Section } from "./parts";
import { personaQueries } from "./queries";
import { LeaveDialog } from "./text-editor";

const KNOWLEDGE_PATHS = [
  "knowledge.facts.files",
  "knowledge.facts.subject",
  "knowledge.factsCandidates",
  "knowledge.archiveCandidates",
  "knowledge.archive.skipTypes",
  "knowledge.rerank.enabled",
  "knowledge.rerank.model",
  "knowledge.gate.enabled",
  "knowledge.gate.model",
] as const;

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
}: {
  readonly persona: string;
  readonly command: "ingest-facts" | "ingest-streams" | "build-stream-catalog";
  readonly label: string;
  readonly running: boolean;
}) {
  const start = useStartJob();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={running || start.isPending}
      onClick={() => start.mutate({ command, persona })}
    >
      <PlayIcon />
      {label}
    </Button>
  );
}

function IndexTables({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const lang = useLang();
  const index = useQuery(personaQueries(persona.id).index);
  if (index.isPending) return <Skeleton className="h-24" />;
  if (index.isError) return <LoadError error={index.error} />;
  return (
    <div className="flex flex-col gap-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("studio.index.table")}</TableHead>
            <TableHead>{t("studio.index.rows")}</TableHead>
            <TableHead>{t("studio.index.builtAt")}</TableHead>
            <TableHead>{t("studio.index.model")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {index.data.tables.map((table) => (
            <TableRow key={table.table}>
              <TableCell>
                <div className="font-medium">{t(`studio.index.${table.table}`)}</div>
                <div className="text-muted-foreground text-xs">
                  {t("studio.index.builtBy", { job: t(`jobs.command.${BUILDS[table.table]}`) })}
                </div>
              </TableCell>
              <TableCell className="tabular-nums">
                {table.rows === null ? (
                  <Badge variant="outline">{t("studio.index.notBuilt")}</Badge>
                ) : (
                  formatCount(table.rows, lang)
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {table.builtAt === null ? "—" : formatDateTime(table.builtAt, lang)}
              </TableCell>
              <TableCell>
                {table.model !== null && (
                  <span className="font-mono text-muted-foreground text-xs">
                    {table.model}
                    {table.dim !== null && ` · ${table.dim}`}
                  </span>
                )}
                {table.stale && (
                  <Badge variant="destructive" className="ml-2">
                    {t("studio.index.stale")}
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {index.data.tables.some((table) => table.stale) && (
        <p className="text-destructive text-sm">{t("studio.index.staleHelp")}</p>
      )}
      <p className="text-muted-foreground text-xs">
        {index.data.catalogBuiltAt === null
          ? t("studio.index.noCatalog")
          : t("studio.index.catalog", { time: formatDateTime(index.data.catalogBuiltAt, lang) })}
      </p>
    </div>
  );
}

function FactsSection({ persona }: { readonly persona: PersonaSummary }) {
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

  function onDeleted(name: string) {
    const file = files.find((entry) => entry.name === name);
    if (file && wasIndexed(file, factsTable)) setDeleted((names) => [...names, name]);
    setDirty(false);
    setTarget(null);
  }

  return (
    <Section
      title={t("studio.facts.title")}
      description={t("studio.facts.description")}
      action={
        <Button size="sm" variant="outline" onClick={() => open({ kind: "new" })}>
          <FilePlusIcon />
          {t("studio.facts.new")}
        </Button>
      }
    >
      {facts.isPending && <Skeleton className="h-32" />}
      {facts.isError && <LoadError error={facts.error} />}
      {facts.data && (
        <>
          <p className="text-muted-foreground text-xs">
            {t("studio.facts.patterns", { patterns: facts.data.patterns.join(", ") || "—" })}
          </p>
          {files.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
              {t("studio.facts.empty")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("studio.facts.name")}</TableHead>
                  <TableHead>{t("studio.facts.size")}</TableHead>
                  <TableHead>{t("studio.facts.modified")}</TableHead>
                  <TableHead>{t("studio.facts.state")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((file) => (
                  <TableRow
                    key={file.name}
                    data-state={
                      target?.kind === "file" && target.name === file.name ? "selected" : undefined
                    }
                  >
                    <TableCell className="font-medium">{file.name}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatBytes(file.size, lang)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(file.mtime, lang)}
                    </TableCell>
                    <TableCell>
                      {!file.matched ? (
                        <Badge variant="outline">{t("studio.facts.notMatched")}</Badge>
                      ) : file.changed ? (
                        <Badge variant="secondary">{t("studio.facts.changed")}</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          {t("studio.facts.indexed")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => open({ kind: "file", name: file.name })}
                      >
                        <PencilIcon />
                        {t("studio.facts.edit")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {target && (
            <FactEditor
              persona={persona.id}
              target={target}
              existing={files.map((file) => file.name)}
              onSelect={(next) => {
                setDirty(false);
                setTarget(next);
              }}
              onClose={() => open(null)}
              onDeleted={onDeleted}
              onDirtyChange={setDirty}
            />
          )}
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
          <div className="flex flex-wrap items-center gap-3">
            <RunButton
              persona={persona.id}
              command="ingest-facts"
              label={t("studio.facts.ingest")}
              running={factsJob?.status === "running"}
            />
            <span className="text-muted-foreground text-xs">{t(hint.key, hint.vars)}</span>
          </div>
        </>
      )}
      {factsJob && <JobCard key={factsJob.id} job={factsJob} onEnded={onEnded} />}
      <LeaveDialog
        open={pending !== null}
        onStay={() => setPending(null)}
        onLeave={() => {
          setDirty(false);
          setTarget(pending?.next ?? null);
          setPending(null);
        }}
      />
    </Section>
  );
}

export function KnowledgeTab({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const { data: jobs } = useQuery(jobsQuery);
  const streamsJob = latestJob(jobs ?? [], persona.id, ["ingest-streams", "build-stream-catalog"]);
  const onEnded = useIngestEnded(persona.id);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const streamsRunning = streamsJob?.status === "running";

  return (
    <div className="flex flex-col gap-6">
      <FactsSection persona={persona} />
      <Section title={t("studio.index.title")} description={t("studio.index.description")}>
        <IndexTables persona={persona} />
        <div className="flex flex-wrap gap-2">
          <RunButton
            persona={persona.id}
            command="ingest-streams"
            label={t("studio.index.ingestStreams")}
            running={streamsRunning}
          />
          <RunButton
            persona={persona.id}
            command="build-stream-catalog"
            label={t("studio.index.buildCatalog")}
            running={streamsRunning}
          />
        </div>
        {streamsJob && <JobCard key={streamsJob.id} job={streamsJob} onEnded={onEnded} />}
      </Section>
      <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">
            <ChevronDownIcon className={settingsOpen ? "rotate-180" : undefined} />
            {t("studio.knowledge.settings")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          {settingsOpen && (
            <SettingsForm scope="persona" persona={persona.id} paths={KNOWLEDGE_PATHS} />
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
