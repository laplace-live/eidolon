// How the desktop companion's page tells main she is drawn, so main never shows a window that
// hasn't drawn her: her window shaped, at its size, and a frame of her on it.
import type { Box } from "@laplace.live/eidolon-sdk/avatar";
import type { CompanionDrawn, CompanionShape, WindowSize } from "@/lib/desktop";

/** The narrowest and widest framing her window takes; a box past them is letterboxed in it. */
export const MIN_ASPECT = 0.1;
export const MAX_ASPECT = 4;
/** How long the handshake waits for her window to take the size main gave it. */
export const SIZE_WAIT_MS = 1_000;

/** Her window's shape for her view: her box's width over its height, clamped into [MIN_ASPECT, MAX_ASPECT]; or her picture. */
export function companionShape(view: "model" | "picture", box: Box | null): CompanionShape {
  if (view === "picture" || box === null) return { kind: "picture" };
  const aspect = Math.min(Math.max(box.width / box.height, MIN_ASPECT), MAX_ASPECT);
  return { kind: "model", aspect };
}

export interface HandshakeSteps {
  /** bridge.shape: main sizes her window and answers the size it gave. */
  shape(shape: CompanionShape): Promise<WindowSize>;
  /** Resolves once innerWidth and innerHeight are `size` (on resize), or after SIZE_WAIT_MS. */
  sized(size: WindowSize): Promise<void>;
  /** document.hidden. */
  hidden(): boolean;
  /** One drawn frame of her model (stage.alphaAt(0, 0) answers after the next draw), or two animation frames for her picture. */
  frame(view: "model" | "picture"): Promise<void>;
  /** bridge.drawn. */
  drawn(view: CompanionDrawn): void;
}

/** Shapes her window, waits for its size and, unless hidden, a drawn frame, then says she is drawn: nothing once `signal` aborts or a step rejects. */
export async function handshake(
  view: "model" | "picture",
  box: Box | null,
  steps: HandshakeSteps,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (signal.aborted) return;
    const size = await steps.shape(companionShape(view, box));
    if (signal.aborted) return;
    await steps.sized(size);
    if (signal.aborted) return;
    // A window main has hidden draws nothing until shown, and her stage resumes by itself then.
    if (!steps.hidden()) {
      await steps.frame(view);
      if (signal.aborted) return;
    }
    steps.drawn(view);
  } catch {
    // Main refused the shape, or she stopped drawing: she stays as main has her.
  }
}
