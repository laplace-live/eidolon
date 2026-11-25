import { useLingui } from "@lingui/react/macro";
import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon, SendHorizontalIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UnavailableButton } from "@/components/unavailable-button";
import { cn } from "@/lib/utils";
import type { CallHandle } from "./use-call";

export function MessageInput({
  disabled,
  name,
  onSend,
  autoFocus,
  round = false,
}: {
  readonly disabled: boolean;
  readonly name: string;
  readonly onSend: (text: string) => void;
  readonly autoFocus?: boolean;
  /** Pill-shaped, for a pill-shaped bar. */
  readonly round?: boolean;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const box = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);

  // autoFocus can't focus a box opened before the call is live: it takes the focus once enabled,
  // unless the viewer has moved it since.
  useEffect(() => {
    if (!autoFocus) return;
    if (disabled) opener.current ??= document.activeElement;
    else if (opener.current !== null) {
      if (document.activeElement === opener.current) box.current?.focus();
      opener.current = null;
    }
  }, [autoFocus, disabled]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || text.trim() === "") return;
    onSend(text);
    setText("");
  }

  // Safari ends an IME composition before the Enter that confirms it, which would send the form.
  function keepComposing(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  }

  const placeholder = t`Type a message to ${name}`;
  return (
    <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={submit}>
      <Input
        ref={box}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keepComposing}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        autoComplete="off"
        enterKeyHint="send"
        autoFocus={autoFocus}
        className={cn("h-9 bg-card", round && "rounded-full px-4")}
      />
      <Button
        type="submit"
        variant="outline"
        size="icon-lg"
        className={cn(round && "rounded-full")}
        disabled={disabled || text.trim() === ""}
        aria-label={t`Send`}
      >
        <SendHorizontalIcon />
      </Button>
    </form>
  );
}

/** Mutes and unmutes the viewer's mic, once the call is live; round for a pill-shaped bar. */
export function MicToggle({
  call,
  round = false,
}: {
  readonly call: CallHandle;
  readonly round?: boolean;
}) {
  const { t } = useLingui();
  const micLabel = call.micOn ? t`Mute your mic` : t`Unmute your mic`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={call.micOn ? "outline" : "destructive"}
          size="icon-lg"
          className={cn(round && "rounded-full")}
          aria-label={micLabel}
          aria-pressed={!call.micOn}
          disabled={call.phase.name !== "live"}
          onClick={() => call.setMic(!call.micOn)}
        >
          {call.micOn ? <MicIcon /> : <MicOffIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{micLabel}</TooltipContent>
    </Tooltip>
  );
}

/** Round for a pill-shaped bar. */
export function HangUpButton({
  call,
  round = false,
}: {
  readonly call: CallHandle;
  readonly round?: boolean;
}) {
  const { t } = useLingui();
  return (
    <Button
      variant="destructive"
      size="lg"
      className={cn("shrink-0 max-sm:w-9 max-sm:px-0", round && "rounded-full")}
      disabled={call.phase.name === "ending"}
      onClick={call.hangUp}
    >
      <PhoneOffIcon />
      {/* On a phone the row needs the width; the name stays for screen readers. */}
      <span className="max-sm:sr-only">{t`Hang Up`}</span>
    </Button>
  );
}

/** Call, or once in a call: the mic, the text box and the hang-up. */
export function CallControls({
  call,
  name,
  onStart,
  unavailable = null,
}: {
  readonly call: CallHandle;
  readonly name: string;
  readonly onStart: () => void;
  /** Why Call can't be used now, shown in its tooltip; null while it can. */
  readonly unavailable?: string | null;
}) {
  const { t } = useLingui();
  const { phase } = call;

  if (phase.name === "idle" || phase.name === "ended") {
    const label = phase.name === "ended" ? t`Call Again` : t`Call ${name}`;
    return (
      <div className="flex justify-center px-4 py-4 sm:px-6">
        {unavailable === null ? (
          <Button size="lg" onClick={onStart}>
            <PhoneIcon data-icon="inline-start" />
            {label}
          </Button>
        ) : (
          <UnavailableButton size="lg" variant="default" reason={unavailable}>
            <PhoneIcon data-icon="inline-start" />
            {label}
          </UnavailableButton>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-4 py-4 sm:px-6">
      <MicToggle call={call} />
      <MessageInput disabled={phase.name !== "live"} name={name} onSend={call.sendText} />
      <HangUpButton call={call} />
    </div>
  );
}

/** Over the transcript's foot during a call: that the bot hears the viewer, or can't. */
export function MicPill({
  call,
  className,
}: {
  readonly call: CallHandle;
  readonly className?: string;
}) {
  const { t } = useLingui();
  const live = call.phase.name === "live";
  const muted = live && !call.micOn;
  const listening = live && call.micOn && call.userSpeaking;
  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-2 flex justify-center",
        className,
      )}
    >
      {(muted || listening) && (
        <span className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm">
          {muted ? (
            <MicOffIcon className="size-3.5" />
          ) : (
            <span className="size-2 animate-pulse rounded-full bg-success" />
          )}
          {muted ? t`Your mic is muted` : t`Listening…`}
        </span>
      )}
    </div>
  );
}
