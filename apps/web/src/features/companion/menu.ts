// Her right-click menu, which main builds and shows natively: what her page tells it, and which
// picks her page acts on itself.
import type { CharacterModels } from "@/lib/api";
import type { CompanionMenuState, CompanionPick } from "@/lib/desktop";
import type { CompanionCall } from "./protocol";

/** As many of each list as main's menu takes. */
const MAX_MODELS = 50;
const MAX_OUTFITS = 32;

const named = ({ id, name }: { readonly id: string; readonly name: string }) => ({ id, name });

/** Her menu's state: the call from the port, her models and outfits from the API. */
export function menuState(input: {
  readonly linked: boolean;
  readonly call: CompanionCall;
  readonly models: CharacterModels | undefined;
}): CompanionMenuState {
  const { linked, call, models } = input;
  const active = models?.active ?? null;
  const model = models?.models.find(({ id }) => id === active) ?? null;
  const outfits = (model?.outfits ?? []).slice(0, MAX_OUTFITS).map(named);
  const worn = model?.outfit ?? null;
  return {
    call: call.up ? "up" : linked && call.callable ? "idle" : "open",
    live: call.live,
    micOn: call.micOn,
    models: (models?.models ?? []).slice(0, MAX_MODELS).map(named),
    model: active,
    outfits,
    outfit: outfits.some(({ id }) => id === worn) ? worn : null,
  };
}

export type PageAction =
  | { readonly kind: "model"; readonly id: string }
  | { readonly kind: "outfit"; readonly id: string | null };

/** What the page does for a pick; null for one main acted on alone, the call's picks included. */
export function pageAction(pick: CompanionPick | null): PageAction | null {
  if (pick?.startsWith("model:")) {
    const id = pick.slice("model:".length);
    return id === "" ? null : { kind: "model", id };
  }
  if (pick?.startsWith("outfit:")) {
    const id = pick.slice("outfit:".length);
    return { kind: "outfit", id: id === "" ? null : id };
  }
  return null;
}

/** Whose models and outfits her menu listed, or whose they are now. */
export interface MenuTarget {
  readonly persona: string | undefined;
  readonly model: string | undefined;
}

/**
 * Whether a pick still applies: her menu listed `opened`'s models and outfits, and the active
 * persona, or for an outfit her model, may have changed while it was open.
 */
export function pickHolds(opened: MenuTarget, now: MenuTarget, action: PageAction): boolean {
  if (opened.persona === undefined || opened.persona !== now.persona) return false;
  return action.kind === "model" || opened.model === now.model;
}
