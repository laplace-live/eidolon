// A group call's screen: a tile per persona, host first, the one speaking lit. Each tile follows
// only its own persona's direction, so a turn changing hands re-renders two tiles, not the screen.
import { memo, useSyncExternalStore } from "react";
import { shortNameOf } from "@/features/chats/persona";
import { cn } from "@/lib/utils";
import { AvatarView } from "./avatar-view";
import { useCallPresence } from "./call-context";
import { Face } from "./call-state";
import type { CastMember } from "./target";

// Written out whole, so Tailwind finds each class.
const GRID: Readonly<Partial<Record<number, string>>> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-2",
  4: "grid-cols-2",
  5: "grid-cols-2 md:grid-cols-3",
  6: "grid-cols-2 md:grid-cols-3",
};

function Tile({ member }: { readonly member: CastMember }) {
  const { signals } = useCallPresence();
  const read = () => signals.direction(member.id).speaking;
  const speaking = useSyncExternalStore(signals.subscribe, read, read);
  return (
    <div
      data-tile={member.id}
      data-speaking={speaking}
      className="relative overflow-hidden rounded-xl bg-muted/60 ring-2 ring-transparent data-[speaking=true]:ring-success motion-safe:transition-shadow"
    >
      {member.appearance.model !== null ? (
        <AvatarView member={member} face="xl" className="absolute inset-0" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Face persona={member} size="xl" speaking={speaking} />
        </div>
      )}
      <span className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-full bg-background/80 px-2 py-0.5 text-xs">
        {shortNameOf(member)}
      </span>
    </div>
  );
}

export const CallTiles = memo(function CallTiles({
  cast,
}: {
  readonly cast: readonly CastMember[];
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 grid auto-rows-fr gap-2 p-2",
        GRID[cast.length] ?? "grid-cols-2",
      )}
    >
      {cast.map((member) => (
        <Tile key={member.id} member={member} />
      ))}
    </div>
  );
});
