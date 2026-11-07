import { useQuery } from "@tanstack/react-query";
import { CircleXIcon } from "lucide-react";
import { QuietBadge } from "@/components/quiet-badge";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";

/** Which yt-dlp downloads use, as the status found it. */
export function YtDlpBadge() {
  const t = useT();
  const ytDlp = useQuery(statusQuery).data?.ytDlp;
  if (!ytDlp) return null;
  const [dot, text] =
    ytDlp.state === "installed"
      ? [
          "bg-success",
          ytDlp.tag
            ? t("settings.ytDlp.installed", { tag: ytDlp.tag })
            : t("settings.ytDlp.installedUnknown"),
        ]
      : ytDlp.state === "installs-on-first-download"
        ? ["bg-muted-foreground/40", t("settings.ytDlp.onFirstDownload")]
        : ["bg-destructive", t("settings.ytDlp.unavailable")];
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
