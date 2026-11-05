import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, FilePlusIcon, PencilIcon, PlayIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { SettingsForm } from "@/components/settings-form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { toastError } from "@/features/jobs/feedback";
import { formatBytes, formatCount, formatDateTime } from "@/features/jobs/format";
import { JobCard } from "@/features/jobs/parts";
import { jobsQuery, useStartJob } from "@/features/jobs/queries";
import type { IndexTable, JobCommand, PersonaSummary } from "@/lib/api";
import { useLang, useT } from "@/lib/i18n";
import { latestJob } from "@/lib/jobs";
import { statusQuery } from "@/lib/query";
import { FactEditor, type FactTarget } from "./facts-editor";
import { LoadError, Section } from "./parts";
import { personaQueries } from "./queries";

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
      onClick={() => start.mutate({ command, persona }, { onError: toastError })}
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
  const { data: jobs } = useQuery(jobsQuery);
  const factsJob = latestJob(jobs ?? [], persona.id, ["ingest-facts"]);
  const onEnded = useIngestEnded(persona.id);
  const [target, setTarget] = useState<FactTarget | null>(null);
  const [dirty, setDirty] = useState(false);
  // A switch the viewer asked for while the open file has unsaved edits, waiting for an answer.
  const [pending, setPending] = useState<{ readonly next: FactTarget | null } | null>(null);

  function open(next: FactTarget | null) {
    if (dirty) setPending({ next });
    else setTarget(next);
  }

  const files = facts.data?.files ?? [];
  const changed = files.filter((file) => file.matched && file.changed).length;
  const matched = files.filter((file) => file.matched).length;

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
              onDirtyChange={setDirty}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <RunButton
              persona={persona.id}
              command="ingest-facts"
              label={t("studio.facts.ingest")}
              running={factsJob?.status === "running"}
            />
            <span className="text-muted-foreground text-xs">
              {matched === 0
                ? t("studio.facts.nothingMatched")
                : changed > 0
                  ? t("studio.facts.changedCount", { count: changed })
                  : t("studio.facts.ingestHelp")}
            </span>
          </div>
        </>
      )}
      {factsJob && <JobCard key={factsJob.id} job={factsJob} onEnded={onEnded} />}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("studio.editor.leaveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("studio.editor.leaveBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("studio.editor.stay")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDirty(false);
                setTarget(pending?.next ?? null);
                setPending(null);
              }}
            >
              {t("studio.editor.leave")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
