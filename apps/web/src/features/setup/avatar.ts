// A new persona's optional avatar: checked as the studio checks pictures, uploaded once she exists.
import { toast } from "sonner";
import { avatarChanged } from "@/components/avatar/version";
import { ApiError, call, errorKey } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { PersonaRef } from "./personas";

/**
 * Uploads `file` as her avatar. A refusal only toasts: she exists either way, and her studio can
 * take another picture.
 */
export async function addAvatar(persona: PersonaRef, file: Blob): Promise<boolean> {
  try {
    await call("PUT /api/local/personas/:id/avatar", { params: { id: persona.id }, body: file });
  } catch (error) {
    // A 401 already sends the app to the locked screen.
    if (!(error instanceof ApiError && error.status === 401)) {
      toast.error(t("setup.avatar.failed", { name: persona.name }), {
        description: t(errorKey(error)),
      });
    }
    return false;
  }
  avatarChanged(persona.id);
  return true;
}
