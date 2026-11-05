// The form for SETTINGS rows, built from GET settings: the settings page shows the app scope, and
// the persona studio mounts persona-scope sections of it.
import type { SettingScope } from "@/lib/api";

export interface SettingsFormProps {
  /** settings.yaml (`app`) or the persona's persona.yaml (`persona`). */
  readonly scope: SettingScope;
  /** Whose values to show and save; required for the persona scope. */
  readonly persona?: string;
  /** Only these SETTINGS paths, in this order; every row of the scope when absent. */
  readonly paths?: readonly string[];
  /** After a save the server accepted. */
  readonly onSaved?: () => void;
}

export function SettingsForm(_props: SettingsFormProps) {
  return null;
}
