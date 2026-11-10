// The composer's microphone: hold it to talk and let go to send, or click it to start and click
// again to send. Letting go away from it, Escape or the cancel button throws the take away.
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowUpIcon, MicIcon, XIcon } from "lucide-react";
import { type PointerEvent, useEffect, useRef } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Recorder } from "./use-recorder";
import { clock, HOLD_MS, MAX_RECORDING_MS } from "./voice";

/** Whether the viewer can send a voice message: a hearing key and a browser that records. */
export type MicState = "ready" | "no-key" | "unsupported";

function released(event: PointerEvent<HTMLElement>): "inside" | "outside" {
  const box = event.currentTarget.getBoundingClientRect();
  const inside =
    event.clientX >= box.left &&
    event.clientX <= box.right &&
    event.clientY >= box.top &&
    event.clientY <= box.bottom;
  return inside ? "inside" : "outside";
}

/** The microphone while it can't be used, saying why. */
function MicUnavailable({ state }: { readonly state: Exclude<MicState, "ready"> }) {
  const { t } = useLingui();
  // aria-disabled rather than disabled, which would take the tooltip's hover and focus too.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          aria-disabled
          aria-label={t`Record Voice Message`}
          className="shrink-0 cursor-not-allowed opacity-50 hover:bg-card"
          onClick={(event) => event.preventDefault()}
        >
          <MicIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {state === "no-key" ? (
          <span>
            <Trans>
              Voice messages need a key for speech recognition.{" "}
              <Link to="/settings?tab=providers" className="underline underline-offset-2">
                Add one in Settings → Providers
              </Link>
              .
            </Trans>
          </span>
        ) : (
          t`This browser can't record audio here.`
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The microphone button, which sends the take while it records. A press held past HOLD_MS is
 * hold-to-talk; a shorter one leaves it recording until the next click.
 */
export function MicButton({
  recorder,
  state,
  onHolding,
}: {
  readonly recorder: Recorder;
  readonly state: MicState;
  /** Whether a press is holding the take open, for the hint beside it. */
  readonly onHolding: (holding: boolean) => void;
}) {
  const { t } = useLingui();
  const press = useRef<{ readonly at: number; readonly fromIdle: boolean } | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { phase, start, stop } = recorder;

  useEffect(
    () => () => {
      if (hold.current !== null) clearTimeout(hold.current);
    },
    [],
  );

  if (state !== "ready") return <MicUnavailable state={state} />;

  function letGo() {
    if (hold.current !== null) clearTimeout(hold.current);
    hold.current = null;
    onHolding(false);
    const pressed = press.current;
    press.current = null;
    return pressed;
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { at: performance.now(), fromIdle: phase === "idle" };
    if (phase !== "idle") return;
    start();
    hold.current = setTimeout(() => onHolding(true), HOLD_MS);
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const pressed = letGo();
    if (pressed === null) return;
    // The second click of click-to-talk.
    if (!pressed.fromIdle) {
      stop(true);
      return;
    }
    // A short press is a click: it keeps recording. So does one let go while the microphone was
    // still being opened, as when the browser asked for permission.
    if (performance.now() - pressed.at >= HOLD_MS && phase === "recording") {
      stop(released(event) === "inside");
    }
  }

  function onPointerCancel() {
    const pressed = letGo();
    if (pressed?.fromIdle && performance.now() - pressed.at >= HOLD_MS) stop(false);
  }

  const recording = phase !== "idle";
  return (
    <Button
      type="button"
      size="icon-lg"
      variant={recording ? "default" : "outline"}
      className="shrink-0 touch-none select-none"
      aria-label={recording ? t`Send Voice Message` : t`Record Voice Message`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(event) => event.preventDefault()}
      // A pointer's press is handled above; a click with no pointer is the keyboard's.
      onClick={(event) => {
        if (event.detail !== 0) return;
        if (phase === "idle") start();
        else stop(true);
      }}
    >
      {recording ? <ArrowUpIcon /> : <MicIcon />}
    </Button>
  );
}

/** Where the text box was, while a take records: its time, and a way to throw it away. */
export function RecordingBar({
  recorder,
  holding,
}: {
  readonly recorder: Recorder;
  readonly holding: boolean;
}) {
  const { t } = useLingui();
  const { phase, elapsed, stop } = recorder;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      stop(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop]);

  return (
    <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-card pr-3 pl-1 text-sm shadow-xs">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t`Cancel Recording`}
        onClick={() => stop(false)}
      >
        <XIcon />
      </Button>
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full bg-destructive",
          phase === "recording" && "animate-pulse",
        )}
      />
      <span role="status" className="min-w-0 truncate text-muted-foreground">
        {phase === "starting"
          ? t`Opening the microphone…`
          : holding
            ? t`Let go to send, or slide off the button to cancel.`
            : t`Recording a voice message…`}
      </span>
      <span role="timer" className="ml-auto shrink-0 text-xs tabular-nums">
        {clock(elapsed)} / {clock(MAX_RECORDING_MS)}
      </span>
    </div>
  );
}
