// Ongoing Call, at the foot of any page while the tab's call shows nowhere else: whom it is with,
// how it stands, and the way back to it. It shows her picture, never her model: a throw here
// reaches the shell's boundary, which ends the call.
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { PhoneCallIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { shortNameOf } from "@/features/chats/persona";
import { listOf } from "@/lib/labels";
import { statusQuery } from "@/lib/query";
import { useShellCall } from "./call-context";
import { HangUpButton, MicToggle } from "./call-controls";
import { CallNotices } from "./call-notices";
import { CallStatus, Face } from "./call-state";
import { barShown, callPath, hostOf, isUp } from "./target";

/**
 * The bar's ref. Hang Up, Close and Return to Call take the bar, the page's last stop, away with
 * the focus, which the page's content then takes, as from the skip link, so Tab stays in the page.
 * Hang Up has lost it to the body by then: Chrome blurs a button a frame after it is disabled, as
 * Hang Up is while the call ends.
 */
function handFocusOn(section: HTMLElement | null) {
  if (section === null) return;
  return () => {
    const held = document.activeElement;
    if (held !== document.body && !section.contains(held)) return;
    (document.getElementById("content") ?? document.getElementById("main"))?.focus({
      preventScroll: true,
    });
  };
}

export function CallBar(): ReactNode {
  const { t } = useLingui();
  const call = useShellCall();
  const { data: status } = useQuery(statusQuery);
  const { target, phase, botSpeaking } = call;
  if (target === null || !barShown(call)) return null;

  const host = hostOf(target);
  const group = target.kind === "chat" && target.group;
  const name = group ? listOf(target.cast.map(shortNameOf)) : shortNameOf(host);
  const { speaker } = call.transcript;
  const voice =
    group && speaker !== null
      ? target.cast.find((member) => member.id === speaker.persona)
      : undefined;
  return (
    // Never a drag row: Electron builds those in document order, and a page's foot keeps clear of
    // Windows' caption buttons.
    <section
      ref={handFocusOn}
      aria-label={t`Ongoing Call`}
      data-call-bar
      // mt-auto: a page shorter than the window would leave a sticky bar right under it.
      className="sticky bottom-0 z-20 mt-auto shrink-0 border-t bg-background/95 backdrop-blur"
    >
      {status !== undefined && (
        <CallNotices call={call} status={status} name={name} persona={host.id} />
      )}
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5 sm:px-6">
        <Face persona={voice ?? host} size="sm" speaking={botSpeaking} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm leading-tight">
            {!group
              ? host.name
              : botSpeaking && voice !== undefined
                ? t`${ph({ name: shortNameOf(voice) })} is speaking`
                : t`Everyone`}
          </p>
          <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <CallStatus phase={phase} name={name} />
          </p>
        </div>
        {/* Over, it leads to the dock's or /call's Call Again. */}
        <Button variant="outline" size="sm" asChild>
          <Link to={callPath(target)}>
            <PhoneCallIcon />
            <span className="max-sm:sr-only">{t`Return to Call`}</span>
          </Link>
        </Button>
        {isUp(phase) ? (
          <>
            <MicToggle call={call} />
            <HangUpButton call={call} />
          </>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label={t`Close`} onClick={call.close}>
            <XIcon />
          </Button>
        )}
      </div>
    </section>
  );
}
