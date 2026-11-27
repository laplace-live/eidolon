// Fish Audio voices to pick from, with their samples: the account's own, private ones included
// (GET accounts/:id/voices), and the public library (GET voices/search), which goes out without the
// key, so it never takes a TTS slot from a live call. The wizard's voice step, persona creation,
// home's voice dialog and the studio's voice tab use it; samples play only through <audio src>.

import { useLingui } from "@lingui/react/macro";
import { useInfiniteQuery } from "@tanstack/react-query";
import { type SyntheticEvent, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Voice } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useLang } from "@/locales/i18n";
import { type LibraryFilter, LibraryPanel } from "./library";
import { MinePanel, type OwnFilter } from "./mine";
import { type ListProps, ResultsSkeleton } from "./parts";
import { ownVoicesQuery } from "./queries";
import { DEFAULT_SEARCH_LANGUAGE, openingSource, type VoiceSource } from "./voices";

export interface VoicePickerProps {
  /** The chosen voice's id (FISH_VOICE_ID), or null before one is picked. */
  readonly value: string | null;
  readonly onChange: (voice: Voice) => void;
  /** The Fish account she speaks through, whose own voices it lists; null for the library alone. */
  readonly account: string | null;
  readonly disabled?: boolean;
  /** Leaves out the line naming a chosen voice the results don't show, for a page that names it. */
  readonly hideCurrent?: boolean;
}

export function VoicePicker({
  value,
  onChange,
  account,
  disabled = false,
  hideCurrent = false,
}: VoicePickerProps) {
  const { t } = useLingui();
  const lang = useLang();
  const [library, setLibrary] = useState<LibraryFilter>({
    text: "",
    language: DEFAULT_SEARCH_LANGUAGE,
  });
  const [mine, setMine] = useState<OwnFilter>({ text: "", visibility: "" });
  const [picked, setPicked] = useState<VoiceSource | null>(null);
  const playing = useRef<HTMLAudioElement | null>(null);
  // Every voice of the account, whatever the search: whether it has any picks the opening list.
  const own = useInfiniteQuery({
    ...ownVoicesQuery(account ?? "", "", ""),
    enabled: account !== null,
  });

  // One sample at a time: starting another pauses the one playing.
  function onPlay(event: SyntheticEvent<HTMLAudioElement>) {
    if (playing.current && playing.current !== event.currentTarget) playing.current.pause();
    playing.current = event.currentTarget;
  }

  const shared: ListProps = { value, hideCurrent, disabled, onChoose: onChange, onPlay };
  const libraryPanel = <LibraryPanel filter={library} onFilter={setLibrary} {...shared} />;
  if (account === null) return libraryPanel;

  const first = own.data?.pages[0];
  const source = picked ?? openingSource(first, own.isError);
  const count =
    first?.status === "ok" && first.total > 0
      ? `${formatCount(first.total, lang)}${first.totalIsExact ? "" : "+"}`
      : null;
  return (
    <Tabs
      value={source ?? ""}
      onValueChange={(next) => setPicked(next === "mine" ? "mine" : "library")}
      className="gap-3"
    >
      <TabsList>
        <TabsTrigger value="mine" className="px-3">
          {t`My Voices`}
          {count !== null && (
            <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
          )}
        </TabsTrigger>
        <TabsTrigger value="library" className="px-3">
          {t`Public Library`}
        </TabsTrigger>
      </TabsList>
      {source === null && <ResultsSkeleton />}
      {/* A tab panel is text-sm; the lists keep the size their page gives them. */}
      <TabsContent value="mine" className="min-w-0 text-[length:inherit]">
        <MinePanel
          account={account}
          overview={first}
          filter={mine}
          onFilter={setMine}
          {...shared}
        />
      </TabsContent>
      <TabsContent value="library" className="min-w-0 text-[length:inherit]">
        {libraryPanel}
      </TabsContent>
    </Tabs>
  );
}
