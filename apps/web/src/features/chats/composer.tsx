import { useLingui } from "@lingui/react/macro";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** The server's limit, in code points; maxLength counts UTF-16 units, which is stricter. */
const TEXT_MAX = 4000;

/**
 * The text box: Enter sends and Shift+Enter breaks the line. A send while she replies is allowed,
 * since the server interrupts her; Stop shows while she does.
 */
export function Composer({
  name,
  busy,
  onSend,
  onStop,
}: {
  readonly name: string;
  readonly busy: boolean;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const trimmed = text.trim();

  // A phone's keyboard would cover the chat it just opened.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) ref.current?.focus();
  }, []);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (trimmed === "") return;
    onSend(trimmed);
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // Safari ends an IME composition before the Enter that confirms it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  }

  const placeholder = t`Message ${name}`;
  return (
    <form className="flex items-end gap-2" onSubmit={submit}>
      <Textarea
        ref={ref}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={TEXT_MAX}
        rows={1}
        enterKeyHint="send"
        className="max-h-40 min-h-9 resize-none bg-card py-1.5"
      />
      {busy && (
        <Button type="button" variant="outline" size="lg" className="shrink-0" onClick={onStop}>
          <SquareIcon className="fill-current" />
          {t`Stop`}
        </Button>
      )}
      <Button
        type="submit"
        size="icon-lg"
        className="shrink-0"
        disabled={trimmed === ""}
        aria-label={t`Send`}
      >
        <ArrowUpIcon />
      </Button>
    </form>
  );
}
