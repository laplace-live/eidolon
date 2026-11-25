// The Motion tab: how far her gaze turns her toward what she looks at, which the preview shows by
// having her look at the pointer while the tab is open.
import type { AvatarStage } from "@laplace.live/eidolon-sdk/avatar";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useId } from "react";
import { cached } from "@/lib/format";
import { useLang } from "@/locales/i18n";
import { ControlGroup, ResetButton } from "./model-controls";

export function MotionPanel({
  stage,
  look,
  onLook,
}: {
  /** Null until her model shows. */
  readonly stage: AvatarStage | null;
  /** 0..1 of the runtime's turn. */
  readonly look: number;
  readonly onLook: (look: number) => void;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const id = useId();
  const title = t`Head Turn`;
  const percent = Math.round(look * 100);
  const shown = cached(
    `percent:${lang}`,
    () => new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }),
  ).format(percent / 100);

  useEffect(() => {
    if (stage === null) return;
    stage.gaze("pointer");
    return () => stage.gaze("direction");
  }, [stage]);

  return (
    <div className="flex flex-col gap-6">
      <ControlGroup
        title={title}
        labelId={id}
        description={t`How far she turns her head, body and eyes toward what she looks at. While this tab is open, she looks at your pointer on the preview.`}
        action={look !== 1 && <ResetButton name={title} onReset={() => onLook(1)} />}
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            aria-labelledby={id}
            aria-valuetext={shown}
            onChange={(event) => onLook(Number(event.target.value) / 100)}
            className="h-2 min-w-0 flex-1 cursor-pointer accent-primary"
          />
          <output className="w-12 shrink-0 text-right text-sm tabular-nums">{shown}</output>
        </div>
      </ControlGroup>
    </div>
  );
}
