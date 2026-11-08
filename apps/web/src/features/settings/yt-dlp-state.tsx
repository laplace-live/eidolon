import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { CircleXIcon } from "lucide-react";
import { QuietBadge } from "@/components/quiet-badge";
import { statusQuery } from "@/lib/query";

/** Which yt-dlp downloads use, as the status found it. */
export function YtDlpBadge() {
  const { t } = useLingui();
  const ytDlp = useQuery(statusQuery).data?.ytDlp;
  if (!ytDlp) return null;
  const [dot, text] =
    ytDlp.state === "installed"
      ? ["bg-success", ytDlp.tag ? t`Version ${ph({ tag: ytDlp.tag })}` : t`Installed`]
      : ytDlp.state === "installs-on-first-download"
        ? ["bg-muted-foreground/40", t`Installs on the first download`]
        : ["bg-destructive", t`Unavailable`];
  return <QuietBadge dot={dot}>{text}</QuietBadge>;
}

/** Why no yt-dlp can run, in the server's English. */
export function YtDlpProblem() {
  const ytDlp = useQuery(statusQuery).data?.ytDlp;
  if (ytDlp?.state !== "unavailable") return null;
  return (
    <p className="flex items-start gap-2 text-destructive text-sm">
      <CircleXIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="wrap-anywhere">{ytDlp.reason}</span>
    </p>
  );
}
