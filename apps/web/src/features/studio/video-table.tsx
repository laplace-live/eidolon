// Every video the persona's sources know, as the plan last saw it, and what the running job is
// doing to each meanwhile.
import type { PlanVideo } from "@eidolon/ingest/progress";
import { ph, plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ExternalLinkIcon, VideoIcon } from "lucide-react";
import { type FormEvent, memo, useId, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { SectionCardTable } from "@/components/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import { reasonText, stageName } from "@/features/jobs/describe";
import { ITEM_STATUS_WORDS } from "@/features/jobs/labels";
import { progressText } from "@/features/jobs/parts";
import { formatDuration, formatUsd } from "@/lib/format";
import type { ItemView } from "@/lib/jobs";
import { type Lang, useLang } from "@/locales/i18n";
import { hasPaidWork, isFinished, needsFfmpeg } from "./videos";

/** Rows shown before "Show more". */
const PAGE = 100;

type Tone = "default" | "secondary" | "destructive" | "outline";

function planState(video: PlanVideo): { text: string; tone: Tone } {
  if (video.download === "pending") return { text: t`Not downloaded`, tone: "outline" };
  if (video.transcribe === "no-date") return { text: t`No upload date`, tone: "destructive" };
  if (video.transcribe === "no-speech") return { text: t`No speech`, tone: "secondary" };
  if (video.transcribe === "pending") return { text: t`To transcribe`, tone: "outline" };
  if (video.refine === null) return { text: t`Transcript unreadable`, tone: "destructive" };
  if (video.refine.done < video.refine.chunks) {
    return {
      text: t`Refined ${ph({ done: video.refine.done })}/${ph({ total: video.refine.chunks })}`,
      tone: "outline",
    };
  }
  if (!video.indexed) return { text: t`To index`, tone: "outline" };
  return { text: t`Indexed`, tone: "secondary" };
}

function liveState(lang: Lang, item: ItemView): { text: string; tone: Tone } {
  const stage = stageName(item.stage);
  if (item.status === "start") {
    const progress = item.progress === null ? null : progressText(lang, item.progress);
    return {
      text: progress === null ? t`${stage}…` : `${stage} · ${progress}`,
      tone: "default",
    };
  }
  if (item.status === "failed") {
    return {
      text: `${stage}: ${reasonText(item.code, item.provider) ?? t`failed`}`,
      tone: "destructive",
    };
  }
  return { text: `${stage}: ${t(ITEM_STATUS_WORDS[item.status])}`, tone: "secondary" };
}

/** A link out, only to an https: page. */
function SourceLink({ url }: { readonly url: string | undefined }) {
  const { t } = useLingui();
  if (url === undefined || !url.startsWith("https://")) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={t`Open the Video's Page`}
      className="text-muted-foreground hover:text-foreground"
    >
      <ExternalLinkIcon className="size-3.5" />
    </a>
  );
}

/** A video without an upload date, transcribed as if streamed on the day the viewer gives. */
function DateDialog({
  video,
  busy,
  onClose,
  onTranscribe,
}: {
  readonly video: PlanVideo | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onTranscribe: (video: PlanVideo, date: string) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [date, setDate] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (video !== null && /^\d{4}-\d{2}-\d{2}$/.test(date)) onTranscribe(video, date);
  }
  return (
    <Dialog open={video !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t`When was it streamed?`}</DialogTitle>
            <DialogDescription>
              {t`${ph({ video: video?.title ?? video?.id ?? "" })} has no upload date, which the stream archive orders by. Give the day it was streamed to transcribe it.`}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={id}>{t`Stream Date`}</FieldLabel>
            <Input
              id={id}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
              className="w-48"
            />
            <FieldDescription>{t`Transcribing bills your Soniox account.`}</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={busy || date === ""}>
              {t`Transcribe`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A video's row: its plan entry and item keep their objects, so only changed rows render. */
const VideoRow = memo(function VideoRow({
  video,
  live,
  ffmpeg,
  busy,
  onSetDate,
}: {
  readonly video: PlanVideo;
  /** The running job's latest item for it. */
  readonly live: ItemView | undefined;
  readonly ffmpeg: boolean;
  readonly busy: boolean;
  readonly onSetDate: (video: PlanVideo) => void;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const state = live ? liveState(lang, live) : planState(video);
  const usd = (video.estimate.transcribeUsd ?? 0) + (video.estimate.refineUsd ?? 0);
  const unpriced = video.estimate.basis === "unpriced" && hasPaidWork(video);
  return (
    <TableRow className="hover:bg-muted/30">
      <TableCell className="max-w-80 whitespace-normal py-3">
        <div className="flex items-center gap-1.5">
          <span className="truncate" title={video.title ?? video.id}>
            {video.title ?? video.id}
          </span>
          <SourceLink url={video.url} />
        </div>
        {video.title && <div className="font-mono text-muted-foreground text-xs">{video.id}</div>}
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        {video.uploadDate ?? "—"}
      </TableCell>
      <TableCell className="tabular-nums">
        {video.durationSec === undefined ? "—" : formatDuration(video.durationSec)}
        {!ffmpeg && needsFfmpeg(video) && (
          <Badge variant="destructive" className="ml-2">
            {t`Needs ffmpeg`}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={state.tone}>{state.text}</Badge>
          {!live && video.transcribe === "no-date" && video.download === "done" && (
            <Button variant="link" size="xs" disabled={busy} onClick={() => onSetDate(video)}>
              {t`Set Date`}
            </Button>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {unpriced ? (
          <span
            className="text-muted-foreground"
            title={t`Its length is unknown until it downloads.`}
          >
            ?
          </span>
        ) : usd > 0 ? (
          formatUsd(usd, lang)
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
});

export function VideoTable({
  videos,
  activity,
  ffmpeg,
  busy,
  onTranscribe,
}: {
  readonly videos: readonly PlanVideo[];
  /** The running job's latest item per video id and per URL. */
  readonly activity: ReadonlyMap<string, ItemView>;
  /** ffmpeg is installed. */
  readonly ffmpeg: boolean;
  /** A job runs, so no other can start. */
  readonly busy: boolean;
  readonly onTranscribe: (video: PlanVideo, date: string) => void;
}) {
  const { t } = useLingui();
  const switchId = useId();
  const finished = videos.filter(isFinished).length;
  const [showFinished, setShowFinished] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [dating, setDating] = useState<PlanVideo | null>(null);
  // With nothing left to do, hiding the finished ones would hide everything.
  const all = showFinished || finished === videos.length;
  const shown = all ? videos : videos.filter((video) => !isFinished(video));

  if (videos.length === 0) {
    return (
      <EmptyState
        icon={<VideoIcon />}
        title={t`No videos yet`}
        description={t`Add links above, and each video is listed here with where it stands.`}
      />
    );
  }

  const more = shown.length > limit;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-muted-foreground text-sm">
          {t`${plural(ph({ total: videos.length }), { one: `# video, ${finished} finished`, other: `# videos, ${finished} finished` })}`}
        </p>
        {finished > 0 && finished < videos.length && (
          <div className="flex items-center gap-2">
            <Switch id={switchId} checked={showFinished} onCheckedChange={setShowFinished} />
            <Label htmlFor={switchId} className="font-normal text-sm">
              {t`Show Finished`}
            </Label>
          </div>
        )}
      </div>
      <SectionCardTable
        columns={[
          { id: "video", label: t`Video` },
          { id: "date", label: t`Streamed` },
          { id: "length", label: t`Length` },
          { id: "state", label: t`State` },
          { id: "estimate", label: t`Estimate`, className: "text-right" },
        ]}
        last={!more}
      >
        {shown.slice(0, limit).map((video) => (
          <VideoRow
            key={video.id}
            video={video}
            live={activity.get(video.id) ?? (video.url ? activity.get(video.url) : undefined)}
            ffmpeg={ffmpeg}
            busy={busy}
            onSetDate={setDating}
          />
        ))}
      </SectionCardTable>
      {more && (
        <Button variant="outline" className="self-center" onClick={() => setLimit(limit + PAGE)}>
          {t`Show ${ph({ count: shown.length - limit })} More`}
        </Button>
      )}
      <DateDialog
        key={dating?.id ?? ""}
        video={dating}
        busy={busy}
        onClose={() => setDating(null)}
        onTranscribe={(video, date) => {
          setDating(null);
          onTranscribe(video, date);
        }}
      />
    </>
  );
}
