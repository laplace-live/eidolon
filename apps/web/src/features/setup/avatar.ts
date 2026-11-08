// A new persona's optional avatar: checked as the studio checks pictures, uploaded once she exists.

import { ph, t } from "@lingui/core/macro";
import { toast } from "sonner";
import { avatarChanged } from "@/components/avatar/version";
import { ApiError, call } from "@/lib/api";
import { errorMessage } from "@/lib/labels";
import type { PersonaRef } from "./personas";

/**
 * Uploads `file` as her avatar, and returns her with `avatar` set, for the pages that show her
 * next. A refusal only toasts and returns her as she was: she exists either way, and her studio
 * can take another picture.
 */
export async function addAvatar<P extends PersonaRef>(
  persona: P,
  file: Blob,
): Promise<P & { readonly avatar?: boolean }> {
  try {
    await call("PUT /api/local/personas/:id/avatar", { params: { id: persona.id }, body: file });
  } catch (error) {
    // A 401 already sends the app to the locked screen.
    if (!(error instanceof ApiError && error.status === 401)) {
      toast.error(
        t`${ph({ name: persona.name })} was created, but her avatar didn't upload. Add it in her studio.`,
        {
          description: t(errorMessage(error)),
        },
      );
    }
    return persona;
  }
  avatarChanged(persona.id);
  return { ...persona, avatar: true };
}
