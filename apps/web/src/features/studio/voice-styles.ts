// Her voice styles as the studio edits them: one style at a time, then the whole list saved.
import type { VoiceStyle } from "@/lib/api";

/** A name the studio gives a style: one the model passes back exactly as written. */
const STYLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** @eidolon/tools' DEFAULT_STYLE: her own voice's style, which no style of hers may take. */
const DEFAULT_STYLE = "default";

export type NameProblem = "empty" | "default" | "pattern" | "taken";

/**
 * What keeps `name` from naming a style of hers, `editing` being the one it renames; null if
 * none. A style keeps whatever name it has, which a hand-written persona.yaml may have given it.
 */
export function nameProblem(
  name: string,
  own: readonly VoiceStyle[],
  editing: string | null,
): NameProblem | null {
  if (name === editing) return null;
  if (name === "") return "empty";
  if (name === DEFAULT_STYLE) return "default";
  if (!STYLE_NAME.test(name)) return "pattern";
  return own.some((style) => style.name === name) ? "taken" : null;
}

/** Her styles with `style` in `editing`'s place, or after the others when it is new. */
export function withStyle(
  own: readonly VoiceStyle[],
  editing: string | null,
  style: VoiceStyle,
): VoiceStyle[] {
  const at = own.findIndex((other) => other.name === editing);
  return at === -1 ? [...own, style] : own.with(at, style);
}

export function withoutStyle(own: readonly VoiceStyle[], name: string): VoiceStyle[] {
  return own.filter((style) => style.name !== name);
}

/** The model's built-in words for a style without a hint of its own, or null when it has none. */
export function builtInHint(
  name: string,
  builtInHints: Readonly<Record<string, string>>,
): string | null {
  return Object.hasOwn(builtInHints, name) ? builtInHints[name] : null;
}
