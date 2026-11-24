// A member's stage wherever the call shows her now: the screen, a tile or the dock's thumbnail. The
// stage and its canvas are the call's (stages.ts), so a view only holds the canvas while it is
// mounted, and her picture stands in until her model draws, or for good if it can't.
import {
  Component,
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { cn } from "@/lib/utils";
import { useCallPresence } from "./call-context";
import { Face } from "./call-state";
import type { CastMember } from "./target";

type FaceSize = "sm" | "xl";

/** Her picture, centred in the view. */
function FaceFill({
  member,
  face,
  speaking,
}: {
  readonly member: CastMember;
  readonly face: FaceSize;
  readonly speaking: boolean;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <Face persona={member} size={face} speaking={speaking} />
    </div>
  );
}

/** React has no hook for an error boundary: a stage that throws shows her picture, quietly. */
class StageBoundary extends Component<
  { readonly fallback: ReactNode; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function StageHost({
  member,
  face,
  className,
}: {
  readonly member: CastMember;
  readonly face: FaceSize;
  readonly className: string | undefined;
}) {
  const { signals, stages, target } = useCallPresence();
  const key = target?.kind === "chat" && target.group ? member.id : undefined;
  useSyncExternalStore(stages.subscribe, stages.version, stages.version);
  const entry = stages.get(member.id);
  const readSpeaking = () => signals.direction(key).speaking;
  const speaking = useSyncExternalStore(signals.subscribe, readSpeaking, readSpeaking);
  const readMood = () => signals.direction(key).mood.join(" ");
  const mood = useSyncExternalStore(signals.subscribe, readMood, readMood);
  const box = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const holder = slot.current;
    if (entry === undefined || holder === null) return;
    holder.append(entry.canvas);
    // Only while it is still here: the view she moved to may hold it already.
    return () => {
      if (entry.canvas.parentNode === holder) entry.canvas.remove();
    };
  }, [entry]);

  // Sampled each tick, straight to the DOM: React renders nothing for her mouth or her frames, and
  // an event between two ticks never takes a tick's reading away. Sampled as the view mounts too,
  // so a reading taken right after a move is her stage's count, not none.
  useEffect(() => {
    if (entry === undefined) return;
    const sample = () => {
      const node = box.current;
      if (node === null) return;
      node.dataset.mouth = entry.tap.take().toFixed(2);
      node.dataset.frames = String(entry.frames);
    };
    sample();
    return signals.onTick(sample);
  }, [entry, signals]);

  const state = entry?.state ?? "none";
  return (
    <div
      ref={box}
      data-avatar={member.id}
      data-state={state}
      data-speaking={speaking}
      data-mood={mood}
      className={cn("relative", className)}
    >
      <div ref={slot} className="absolute inset-0" />
      {state !== "ready" && <FaceFill member={member} face={face} speaking={speaking} />}
    </div>
  );
}

/** A member of the call: her model live once her stage is ready, else her picture. */
export const AvatarView = memo(function AvatarView({
  member,
  face,
  className,
}: {
  readonly member: CastMember;
  /** Her picture's size while the model loads, or for good if it failed: the screen's or the dock's. */
  readonly face: "sm" | "xl";
  readonly className?: string;
}): ReactNode {
  return (
    <StageBoundary fallback={<FaceFill member={member} face={face} speaking={false} />}>
      <StageHost member={member} face={face} className={className} />
    </StageBoundary>
  );
});
