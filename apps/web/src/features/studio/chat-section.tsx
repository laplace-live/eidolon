// Chats: whether she answers in text or with her voice, and what the director weighs her by when
// it decides who answers a group's line.

import { useLingui } from "@lingui/react/macro";
import { SettingsCard } from "@/components/settings-form/settings-card";
import type { PersonaSummary } from "@/lib/api";
import { CARD_PATHS } from "./sections";

export function ChatSection({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
  return (
    <SettingsCard
      scope="persona"
      persona={persona.id}
      paths={CARD_PATHS.chat}
      title={t`Chats`}
      description={t`How she answers in chats. In a chat with several personas, a director decides who answers each line, and weighs her by her interests and talkativeness.`}
    />
  );
}
