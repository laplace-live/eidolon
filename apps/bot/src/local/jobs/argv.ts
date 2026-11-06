// What POST /api/local/jobs accepts: a closed set of typed requests, each mapped to a fixed set of
// the CLI's flags. A request never names a flag or a path. A batch and a video are looked up by
// id among the persona's own files, and only this module adds `--persona`.
import { basename, extname } from "node:path";
import { isPlainObject, personaIds, sourceFolder } from "@eidolon/config";
import { download, transcribe } from "@eidolon/ingest";
import {
  type ErrorCode,
  JOB_COMMANDS,
  type JobCommand,
  type JobOptions,
  PIPELINE_STAGES,
  type PipelineStage,
} from "../api.ts";
import { localError } from "../responses.ts";
import { isPersonaId } from "../write.ts";

/** A request the server can run: what its record keeps, and the CLI command line it maps to. */
export interface JobSpec {
  readonly command: JobCommand;
  readonly persona: string;
  /** JobOptions[command], as validated. */
  readonly options: Readonly<Record<string, unknown>>;
  /** The CLI command: `plan` runs the pipeline, `expand` the download. */
  readonly cli: string;
  /** Its arguments after `--json`. */
  readonly args: readonly string[];
}

/** Why a request can't run, as the API answers it. */
export class JobRefused extends Error {
  override readonly name = "JobRefused";
  readonly status: 400 | 404;
  readonly code: ErrorCode;

  constructor(status: 400 | 404, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  response(): Response {
    return localError(this.status, this.code, this.message);
  }
}

/** Each command's option names; the values are checked where the command maps them. */
const OPTION_KEYS = {
  pipeline: ["batch", "stages", "abortOnError", "transcribeConcurrency"],
  download: ["batch"],
  expand: ["url"],
  transcribe: ["video", "date"],
  refine: [],
  "ingest-streams": [],
  "ingest-facts": [],
  "build-stream-catalog": [],
  plan: ["refresh"],
} as const satisfies { readonly [C in JobCommand]: readonly (keyof JobOptions[C])[] };

/** Plans and playlist previews: kept only until a newer one of the same persona. */
export const EPHEMERAL_COMMANDS: ReadonlySet<JobCommand> = new Set(["plan", "expand"]);

/** Commands whose end changes what a plan reports. */
export const SOURCE_COMMANDS: ReadonlySet<JobCommand> = new Set([
  "pipeline",
  "download",
  "transcribe",
  "refine",
  "ingest-streams",
]);

/** Soniox runs at most 25 async transcriptions per account at once. */
const MAX_TRANSCRIBE_CONCURRENCY = 25;

/** A URL a request may hand to yt-dlp or write into a batch. */
const MAX_URL_LENGTH = 2048;

const UNSAFE_URL = /[\s\p{Cc}]/u;

/** `value` if it is an http(s) URL with a host, no whitespace or control character, and short. */
export function checkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || UNSAFE_URL.test(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const web = url.protocol === "http:" || url.protocol === "https:";
  return web && url.hostname !== "" ? value : null;
}

/** A persona the request names, refused unless it is a slug the data home or templates have. */
export function checkPersona(value: unknown, status: 400 | 404): string {
  if (!isPersonaId(value)) {
    throw new JobRefused(400, "invalid-persona-id", "A persona id is a lowercase slug");
  }
  if (!personaIds().includes(value)) {
    throw new JobRefused(status, "unknown-persona", "No persona has that id");
  }
  return value;
}

function invalid(message: string): JobRefused {
  return new JobRefused(400, "invalid-option", message);
}

const BATCH_ID = /^videos-[A-Za-z0-9_-]{1,64}$/;

/** The batch file `id` names: compared against the persona's batches, never joined into a path. */
function batchFile(persona: string, id: unknown): string {
  if (typeof id !== "string" || !BATCH_ID.test(id)) throw invalid("`batch` is not a batch id");
  const path = download
    .batchLists(sourceFolder(persona, "lists"))
    .find((file) => basename(file, ".txt") === id);
  if (path === undefined) throw invalid("The persona has no batch with that id");
  return path;
}

const VIDEO_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** The downloaded audio of video `id` (its file's stem), compared, never joined into a path. */
function audioFile(persona: string, id: unknown): string {
  if (typeof id !== "string" || !VIDEO_ID.test(id)) throw invalid("`video` is not a video id");
  const path = transcribe
    .listAudioFiles(sourceFolder(persona, "vods"))
    .find((file) => basename(file, extname(file)) === id);
  if (path === undefined) throw invalid("The persona has no downloaded video with that id");
  return path;
}

function streamDate(value: unknown): string {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (match !== null) {
    const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return value as string;
  }
  throw invalid("`date` is not a date written YYYY-MM-DD");
}

function stagesOf(value: unknown): PipelineStage[] | undefined {
  if (value === undefined) return undefined;
  const all: readonly unknown[] = PIPELINE_STAGES;
  // An empty --stages is every stage, paid ones included, so an empty list is refused.
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    !value.every((stage) => all.includes(stage))
  ) {
    throw invalid("`stages` lists download, transcribe, refine or ingest, each once");
  }
  return PIPELINE_STAGES.filter((stage) => value.includes(stage));
}

function flagOf(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key];
  if (value === undefined || typeof value === "boolean") return value;
  throw invalid(`\`${key}\` is true or false`);
}

function concurrencyOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_TRANSCRIBE_CONCURRENCY
  ) {
    return value as number;
  }
  throw invalid(
    `\`transcribeConcurrency\` is a whole number from 1 to ${MAX_TRANSCRIBE_CONCURRENCY}`,
  );
}

/** The CLI command and arguments of a request whose options are known to be well-formed keys. */
function mapped(
  command: JobCommand,
  persona: string,
  options: Record<string, unknown>,
): Omit<JobSpec, "command" | "persona"> {
  const who = ["--persona", persona];
  switch (command) {
    case "pipeline": {
      const stages = stagesOf(options.stages);
      // Only the download stage reads the batch; the later ones take every video she has.
      const batch =
        options.batch === undefined && stages?.includes("download") === false
          ? null
          : batchFile(persona, options.batch);
      const abortOnError = flagOf(options, "abortOnError");
      const concurrency = concurrencyOf(options.transcribeConcurrency);
      return {
        options: {
          ...(batch === null ? {} : { batch: options.batch }),
          ...(stages === undefined ? {} : { stages }),
          ...(abortOnError === undefined ? {} : { abortOnError }),
          ...(concurrency === undefined ? {} : { transcribeConcurrency: concurrency }),
        },
        cli: "pipeline",
        args: [
          ...who,
          ...(stages === undefined ? [] : ["--stages", stages.join(",")]),
          ...(abortOnError ? ["--abort-on-error"] : []),
          ...(concurrency === undefined ? [] : ["--transcribe-concurrency", String(concurrency)]),
          ...(batch === null ? [] : ["--", batch]),
        ],
      };
    }
    case "download":
      return {
        options: { batch: options.batch },
        cli: "download",
        args: [...who, "--", batchFile(persona, options.batch)],
      };
    case "expand": {
      const url = checkUrl(options.url);
      if (url === null) {
        throw new JobRefused(400, "invalid-url", "`url` is not an http(s) URL without spaces");
      }
      return { options: { url }, cli: "download", args: [...who, "--expand", url] };
    }
    case "transcribe": {
      const audio = audioFile(persona, options.video);
      const date = streamDate(options.date);
      return {
        options: { video: options.video, date },
        cli: "transcribe",
        // As the pipeline does: audio past Soniox's 300-minute cap is sliced with ffmpeg.
        args: [...who, "--date", date, "--auto-slice", "--", audio],
      };
    }
    case "plan": {
      const refresh = flagOf(options, "refresh");
      return {
        options: refresh === undefined ? {} : { refresh },
        cli: "pipeline",
        args: [...who, "--dry-run"],
      };
    }
    case "refine":
    case "ingest-streams":
    case "ingest-facts":
    case "build-stream-catalog":
      return { options: {}, cli: command, args: who };
  }
}

/** A POST jobs body as the job it runs; throws JobRefused for anything else. */
export function parseJobRequest(body: unknown): JobSpec {
  if (!isPlainObject(body)) {
    throw new JobRefused(400, "bad-request", "Send {command, persona, options}");
  }
  if (Object.keys(body).some((key) => !["command", "persona", "options"].includes(key))) {
    throw new JobRefused(400, "bad-request", "A job takes command, persona and options only");
  }
  const { command } = body;
  if (typeof command !== "string" || !(JOB_COMMANDS as readonly string[]).includes(command)) {
    throw new JobRefused(400, "unknown-command", "No job runs that command");
  }
  const job = command as JobCommand;
  const persona = checkPersona(body.persona, 400);
  const options = body.options ?? {};
  if (!isPlainObject(options)) throw invalid("`options` is an object");
  const known: readonly string[] = OPTION_KEYS[job];
  for (const [key, value] of Object.entries(options)) {
    if (!known.includes(key)) throw invalid("An option the command doesn't take");
    // A value argparse could read as a flag of its own.
    if (typeof value === "string" && value.startsWith("-")) {
      throw invalid("An option's value starts with '-'");
    }
  }
  return { command: job, persona, ...mapped(job, persona, options) };
}
