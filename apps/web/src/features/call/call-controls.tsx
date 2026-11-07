import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon, SendHorizontalIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import type { Call } from "./use-call";

function MessageInput({
  disabled,
  name,
  onSend,
}: {
  readonly disabled: boolean;
  readonly name: string;
  readonly onSend: (text: string) => void;
}) {
  const t = useT();
  const [text, setText] = useState("");

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

  const placeholder = t("call.input.placeholder", { name });
  return (
    <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={submit}>
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keepComposing}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        autoComplete="off"
        enterKeyHint="send"
        className="h-9 bg-card"
      />
      <Button
        type="submit"
        variant="outline"
        size="icon-lg"
        disabled={disabled || text.trim() === ""}
        aria-label={t("call.input.send")}
      >
        <SendHorizontalIcon />
      </Button>
    </form>
  );
}

/** Call, or once in a call: the mic, the text box and the hang-up. */
export function CallControls({ call, name }: { readonly call: Call; readonly name: string }) {
  const t = useT();
  const { phase } = call;

  if (phase.name === "idle" || phase.name === "ended") {
    return (
      <div className="flex justify-center px-4 py-4 sm:px-6">
        <Button size="lg" onClick={call.start}>
          <PhoneIcon data-icon="inline-start" />
          {phase.name === "ended" ? t("call.again") : t("call.start", { name })}
        </Button>
      </div>
    );
  }

  const live = phase.name === "live";
  const micLabel = t(call.micOn ? "call.mic.mute" : "call.mic.unmute");
  return (
    <div className="flex items-center gap-2 px-4 py-4 sm:px-6">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={call.micOn ? "outline" : "destructive"}
            size="icon-lg"
            aria-label={micLabel}
            aria-pressed={!call.micOn}
            disabled={!live}
            onClick={() => call.setMic(!call.micOn)}
          >
            {call.micOn ? <MicIcon /> : <MicOffIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{micLabel}</TooltipContent>
      </Tooltip>
      <MessageInput disabled={!live} name={name} onSend={call.sendText} />
      <Button
        variant="destructive"
        size="lg"
        className="shrink-0 max-sm:w-9 max-sm:px-0"
        disabled={phase.name === "ending"}
        onClick={call.hangUp}
      >
        <PhoneOffIcon />
        {/* On a phone the text box needs the width; the name stays for screen readers. */}
        <span className="max-sm:sr-only">{t("call.hangUp")}</span>
      </Button>
    </div>
  );
}

/** Over the transcript's foot during a call: that the bot hears the viewer, or can't. */
export function MicPill({ call }: { readonly call: Call }) {
  const t = useT();
  const live = call.phase.name === "live";
  const muted = live && !call.micOn;
  const listening = live && call.micOn && call.userSpeaking;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center"
    >
      {(muted || listening) && (
        <span className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm">
          {muted ? (
            <MicOffIcon className="size-3.5" />
          ) : (
            <span className="size-2 animate-pulse rounded-full bg-success" />
          )}
          {t(muted ? "call.muted" : "call.listening")}
        </span>
      )}
    </div>
  );
}
