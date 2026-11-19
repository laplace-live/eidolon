import { parseMentions } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ArrowUpIcon, ScrollTextIcon, SquareIcon, SquareSlashIcon } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
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
import {
  closedAt,
  type Draft,
  EMPTY_DRAFT,
  mentionName,
  mentionSuggestions,
  picked,
  retyped,
  slashSuggestions,
  type Trigger,
} from "./autocomplete";
import {
  type ChatCommand,
  parseCommand,
  type SlashEntry,
  type SlashSkill,
  slashEntries,
} from "./commands";
import { COMMAND_HELP, RECORDER_PROBLEMS } from "./labels";
import { type ChatPersona, shortNameOf } from "./persona";
import type { VoiceClip } from "./stream";
import { useRecorder } from "./use-recorder";
import { MicButton, type MicState, RecordingBar } from "./voice-recorder";

/** The server's limit, in code points; maxLength counts UTF-16 units, which is stricter. */
const TEXT_MAX = 4000;

type Open =
  | { readonly kind: "mention"; readonly at: Trigger; readonly options: readonly ChatPersona[] }
  | { readonly kind: "slash"; readonly at: Trigger; readonly options: readonly SlashEntry[] };

/**
 * What `draft`'s caret could complete, while anything matches: in a group, the participants after
 * an `@`; after the `/` a draft starts with, the commands and `skills`.
 */
function openAt(
  draft: Draft,
  participants: readonly ChatPersona[],
  skills: readonly SlashSkill[],
): Open | null {
  if (participants.length > 1) {
    const { at, options } = mentionSuggestions(draft, participants);
    if (at !== null && options.length > 0) return { kind: "mention", at, options };
  }
  const alone = draft.text.slice(draft.caret).trim() === "";
  const { at, options } = slashSuggestions(draft, slashEntries(skills, alone));
  return at !== null && options.length > 0 ? { kind: "slash", at, options } : null;
}

/**
 * Suggestions above the text box. A click keeps the focus, and so the caret, in the box, and the
 * arrow keys scroll a long list to the option they reach.
 */
function SuggestionList<T>({
  id,
  label,
  options,
  active,
  keyOf,
  onChoose,
  onHover,
  className,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly options: readonly T[];
  readonly active: number;
  readonly keyOf: (option: T) => string;
  readonly onChoose: (index: number) => void;
  readonly onHover: (index: number) => void;
  readonly className: string;
  readonly children: (option: T) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    const option = list?.children[active];
    if (list === null || !(option instanceof HTMLElement)) return;
    const bottom = option.offsetTop + option.offsetHeight;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  });
  return (
    <div
      ref={ref}
      id={id}
      role="listbox"
      aria-label={label}
      className={cn(
        "absolute bottom-full left-0 z-10 mb-2 flex flex-col overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10",
        className,
      )}
    >
      {options.map((option, index) => (
        <div
          key={keyOf(option)}
          id={`${id}-${index}`}
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(index);
          }}
          // Not mouseenter: Chrome fires that when a list opens or narrows under a pointer at rest,
          // which would move the highlight off the first match that Enter takes.
          onMouseMove={() => onHover(index)}
          className={cn(
            "flex min-w-0 shrink-0 cursor-default items-center gap-2 rounded-md px-1.5 py-1.5 text-sm",
            index === active && "bg-accent text-accent-foreground",
          )}
        >
          {children(option)}
        </div>
      ))}
    </div>
  );
}

/**
 * The text box: Enter sends and Shift+Enter breaks the line. A send while a reply runs is allowed,
 * since the server stops it and still answers every line; Stop shows while one does. With two or
 * more personas, an `@` offers their names, and whoever the line mentions answers first. A `/` that
 * starts the draft offers the commands and `skills`. While the box is empty, the microphone takes
 * the send button's place, and a take replaces the box while it records. During a call it is
 * disabled, keeping any draft, and it takes the focus back when the call ends. A command goes to
 * `onCommand`, never to her; one it can't run keeps the draft.
 */
export function Composer({
  placeholder,
  participants,
  skills,
  busy,
  mic,
  inCall,
  onSend,
  onSendVoice,
  onStop,
  onCommand,
}: {
  readonly placeholder: string;
  readonly participants: readonly ChatPersona[];
  /** The owner's skills she can be asked for by name in this chat. */
  readonly skills: readonly SlashSkill[];
  readonly busy: boolean;
  readonly mic: MicState;
  readonly inCall: boolean;
  readonly onSend: (text: string) => void;
  readonly onSendVoice: (clip: VoiceClip) => void;
  readonly onStop: () => void;
  readonly onCommand: (command: ChatCommand) => void;
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
  const open = focused ? openAt(draft, participants, skills) : null;
  const active = open === null ? 0 : Math.min(highlight, open.options.length - 1);
  const mentioned = group ? parseMentions(text, participants) : [];

  // A phone's keyboard would cover the chat it just opened, or the call just ended.
  useEffect(() => {
    if (!inCall && window.matchMedia("(pointer: fine)").matches) ref.current?.focus();
  }, [inCall]);

  // A call takes the microphone, and the chat takes no voice message during one.
  const { stop } = recorder;
  useEffect(() => {
    if (inCall) stop(false);
  }, [inCall, stop]);

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

  function pick(at: Trigger, name: string) {
    const next = picked(draft, at, name);
    placeCaret.current = next.caret;
    setDraft(next);
    setHighlight(0);
  }

  function run(command: ChatCommand) {
    onCommand(command);
    edit("", 0);
  }

  /**
   * Takes option `index` of `list`: a name goes in after its `@` or `/`, and a command runs, unless
   * `complete`, which only puts it in.
   */
  function choose(list: Open, index: number, complete: boolean) {
    if (list.kind === "mention") {
      const persona = list.options[index];
      if (persona !== undefined) pick(list.at, mentionName(persona, participants));
      return;
    }
    const entry = list.options[index];
    if (entry === undefined) return;
    if (entry.kind === "command" && !complete) run(entry.name);
    else pick(list.at, entry.name);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (trimmed === "" || inCall) return;
    const parsed = parseCommand(trimmed, skills);
    switch (parsed.kind) {
      case "command":
        run(parsed.command);
        return;
      case "trailing": {
        const command = `/${parsed.command}`;
        toast.error(t`${ph({ command })} takes nothing after it`, {
          description: t`Send it alone. To send a message, don't start it with a slash.`,
        });
        return;
      }
      case "unknown":
        toast.error(t`${ph({ command: parsed.typed })} isn't a command`, {
          description: t`Type /focus, /normal or /verbose to choose how much of her tasks this chat shows, or /stop to stop one.`,
        });
        return;
      case "line":
        onSend(trimmed);
        edit("", 0);
        return;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Safari ends an IME composition before the Enter that confirms it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (open !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        const count = open.options.length;
        setHighlight((active + step + count) % count);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        choose(open, active, event.key === "Tab");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDraft({ ...draft, closed: closedAt(draft.text, open.at) });
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  }

  const shown = inCall ? t`In a call` : placeholder;
  const names = listOf(
    mentioned.flatMap((id) => {
      const persona = participants.find((entry) => entry.id === id);
      return persona === undefined ? [] : [shortNameOf(persona)];
    }),
  );
  const listProps = { id: listId, active, onHover: setHighlight };
  return (
    <form className="flex flex-col gap-1.5" onSubmit={submit}>
      {mentioned.length > 0 && (
        <p className="text-muted-foreground text-xs">{t`Mentioned: ${ph({ names })}`}</p>
      )}
      <div className="flex items-end gap-2">
        {recording && <RecordingBar recorder={recorder} holding={holding} />}
        <div className="relative min-w-0 flex-1" hidden={recording}>
          {open?.kind === "mention" && (
            <SuggestionList
              {...listProps}
              label={t`Mention`}
              options={open.options}
              keyOf={(persona) => persona.id}
              onChoose={(index) => choose(open, index, false)}
              className="w-64 max-w-full"
            >
              {(persona) => (
                <>
                  <PersonaAvatar persona={persona} size="xs" />
                  <span className="truncate">{persona.name}</span>
                  {mentionName(persona, participants) !== persona.name && (
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                      @{mentionName(persona, participants)}
                    </span>
                  )}
                </>
              )}
            </SuggestionList>
          )}
          {open?.kind === "slash" && (
            <SuggestionList
              {...listProps}
              label={t`Commands and Skills`}
              options={open.options}
              keyOf={(entry) => entry.name}
              onChoose={(index) => choose(open, index, false)}
              className="max-h-72 w-full max-w-md"
            >
              {(entry) => (
                <>
                  {entry.kind === "command" ? (
                    <SquareSlashIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ScrollTextIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate font-medium">/{entry.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                    {entry.kind === "command" ? t(COMMAND_HELP[entry.name]) : entry.description}
                  </span>
                </>
              )}
            </SuggestionList>
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
            placeholder={shown}
            aria-label={shown}
            disabled={inCall}
            aria-autocomplete="list"
            aria-controls={open === null ? undefined : listId}
            aria-activedescendant={open === null ? undefined : `${listId}-${active}`}
            maxLength={TEXT_MAX}
            rows={1}
            enterKeyHint="send"
            className="max-h-40 min-h-9 resize-none bg-card py-1.5"
          />
        </div>
        {busy && !inCall && (
          <Button type="button" variant="outline" size="lg" className="shrink-0" onClick={onStop}>
            <SquareIcon className="fill-current" />
            {t`Stop`}
          </Button>
        )}
        {trimmed === "" && !inCall ? (
          // A take under way can always be sent, whatever the chat learned since it started.
          <MicButton recorder={recorder} state={recording ? "ready" : mic} onHolding={setHolding} />
        ) : (
          <Button
            type="submit"
            size="icon-lg"
            className="shrink-0"
            disabled={inCall}
            aria-label={t`Send`}
          >
            <ArrowUpIcon />
          </Button>
        )}
      </div>
    </form>
  );
}
