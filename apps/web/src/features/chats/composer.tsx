import { parseMentions } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { PersonaAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { listOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { closedAt, EMPTY_DRAFT, mentionName, picked, retyped, suggestions } from "./autocomplete";
import { RECORDER_PROBLEMS } from "./labels";
import { type ChatPersona, shortNameOf } from "./persona";
import type { VoiceClip } from "./stream";
import { useRecorder } from "./use-recorder";
import { MicButton, type MicState, RecordingBar } from "./voice-recorder";

/** The server's limit, in code points; maxLength counts UTF-16 units, which is stricter. */
const TEXT_MAX = 4000;

/**
 * The text box: Enter sends and Shift+Enter breaks the line. A send while a reply runs is allowed,
 * since the server interrupts it; Stop shows while one does. With two or more personas, an `@`
 * offers their names, and whoever the line mentions answers first. While the box is empty, the
 * microphone takes the send button's place, and a take replaces the box while it records.
 */
export function Composer({
  placeholder,
  participants,
  busy,
  mic,
  onSend,
  onSendVoice,
  onStop,
}: {
  readonly placeholder: string;
  readonly participants: readonly ChatPersona[];
  readonly busy: boolean;
  readonly mic: MicState;
  readonly onSend: (text: string) => void;
  readonly onSendVoice: (clip: VoiceClip) => void;
  readonly onStop: () => void;
}) {
  const { t } = useLingui();
  const recorder = useRecorder({
    onClip: onSendVoice,
    onProblem: (problem) =>
      toast.error(t(RECORDER_PROBLEMS[problem].title), {
        description: t(RECORDER_PROBLEMS[problem].body),
      }),
  });
  const recording = recorder.phase !== "idle";
  const [holding, setHolding] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [highlight, setHighlight] = useState(0);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const placeCaret = useRef<number | null>(null);
  const listId = useId();
  const { text } = draft;
  const trimmed = text.trim();

  const group = participants.length > 1;
  const open = group && focused ? suggestions(draft, participants) : null;
  const at = open?.at ?? null;
  const options = open?.options ?? [];
  const active = Math.min(highlight, options.length - 1);
  const mentioned = group ? parseMentions(text, participants) : [];

  // A phone's keyboard would cover the chat it just opened.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) ref.current?.focus();
  }, []);

  // A picked name moves the caret past it once React has put the new text in the box.
  useLayoutEffect(() => {
    if (placeCaret.current === null) return;
    ref.current?.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = null;
  });

  function edit(next: string, position: number) {
    setDraft(retyped(draft, next, position));
    setHighlight(0);
  }

  function pick(target: ChatPersona) {
    if (at === null) return;
    const next = picked(draft, at, mentionName(target, participants));
    placeCaret.current = next.caret;
    setDraft(next);
    setHighlight(0);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (trimmed === "") return;
    onSend(trimmed);
    edit("", 0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Safari ends an IME composition before the Enter that confirms it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const chosen = options[active];
    if (at !== null && chosen !== undefined) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((active + step + options.length) % options.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        pick(chosen);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDraft({ ...draft, closed: closedAt(draft.text, at) });
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  }

  const names = listOf(
    mentioned.flatMap((id) => {
      const persona = participants.find((entry) => entry.id === id);
      return persona === undefined ? [] : [shortNameOf(persona)];
    }),
  );
  return (
    <form className="flex flex-col gap-1.5" onSubmit={submit}>
      {mentioned.length > 0 && (
        <p className="text-muted-foreground text-xs">{t`Mentioned: ${ph({ names })}`}</p>
      )}
      <div className="flex items-end gap-2">
        {recording && <RecordingBar recorder={recorder} holding={holding} />}
        <div className="relative min-w-0 flex-1" hidden={recording}>
          {options.length > 0 && (
            <div
              id={listId}
              role="listbox"
              aria-label={t`Mention`}
              className="absolute bottom-full left-0 z-10 mb-2 flex w-64 max-w-full flex-col rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            >
              {options.map((persona, index) => (
                <div
                  key={persona.id}
                  id={`${listId}-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  // Keeps the focus, and so the caret, in the text box.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(persona);
                  }}
                  onMouseEnter={() => setHighlight(index)}
                  className={cn(
                    "flex cursor-default items-center gap-2 rounded-md px-1.5 py-1.5 text-sm",
                    index === active && "bg-accent text-accent-foreground",
                  )}
                >
                  <PersonaAvatar persona={persona} size="xs" />
                  <span className="truncate">{persona.name}</span>
                  {mentionName(persona, participants) !== persona.name && (
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                      @{mentionName(persona, participants)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <Textarea
            ref={ref}
            value={text}
            onChange={(event) => edit(event.target.value, event.target.selectionStart)}
            onSelect={(event) => {
              const caret = event.currentTarget.selectionStart;
              setDraft((current) => ({ ...current, caret }));
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-autocomplete={group ? "list" : undefined}
            aria-controls={options.length > 0 ? listId : undefined}
            aria-activedescendant={options.length > 0 ? `${listId}-${active}` : undefined}
            maxLength={TEXT_MAX}
            rows={1}
            enterKeyHint="send"
            className="max-h-40 min-h-9 resize-none bg-card py-1.5"
          />
        </div>
        {busy && (
          <Button type="button" variant="outline" size="lg" className="shrink-0" onClick={onStop}>
            <SquareIcon className="fill-current" />
            {t`Stop`}
          </Button>
        )}
        {trimmed === "" ? (
          // A take under way can always be sent, whatever the chat learned since it started.
          <MicButton recorder={recorder} state={recording ? "ready" : mic} onHolding={setHolding} />
        ) : (
          <Button type="submit" size="icon-lg" className="shrink-0" aria-label={t`Send`}>
            <ArrowUpIcon />
          </Button>
        )}
      </div>
    </form>
  );
}
