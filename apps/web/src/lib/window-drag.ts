// The rows the desktop app's window drags by (`data-window-drag`, styled in index.css). Electron
// collects their regions again only when a computed app-region value changes
// (https://github.com/electron/electron/issues/32341), so a row that moves or resizes, as a page's
// does when the sidebar collapses, or that comes and goes with a page, would leave its old region
// behind: a press there would drag the window, or a control moved into it would never get its
// clicks. Each such change flips the app-region of an empty element of our own, once per frame,
// which makes Electron collect them all again.

const ROWS = "[data-window-drag]";

function touchesRows(nodes: NodeList): boolean {
  for (const node of nodes) {
    if (node instanceof Element && (node.matches(ROWS) || node.querySelector(ROWS) !== null)) {
      return true;
    }
  }
  return false;
}

/** Keeps the desktop app's drag regions in step with the rows; call once, in the desktop app. */
export function watchWindowDrag(): void {
  const pulse = document.createElement("div");
  pulse.setAttribute("aria-hidden", "true");
  // Inline, as each flip is: index.css makes anything outside #root no-drag, so a first flip to
  // no-drag would change nothing.
  pulse.style.cssText =
    "position: fixed; top: 0; left: 0; width: 0; height: 0; -webkit-app-region: initial;";
  document.body.append(pulse);
  let flipped = false;
  let pending = false;
  // Two flips before one style pass would cancel out, so a frame flips once whatever asked.
  const recollect = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      flipped = !flipped;
      // `initial` computes to none, which adds no region; an authored `none` would be no-drag.
      pulse.style.setProperty("-webkit-app-region", flipped ? "no-drag" : "initial");
    });
  };

  const sizes = new ResizeObserver(recollect);
  const watched = new Set<Element>();
  const scan = () => {
    const rows = new Set(document.querySelectorAll(ROWS));
    for (const row of watched) {
      if (rows.has(row)) continue;
      sizes.unobserve(row);
      watched.delete(row);
    }
    // A new row reports its first size to the observer, which recollects.
    for (const row of rows) {
      if (watched.has(row)) continue;
      sizes.observe(row);
      watched.add(row);
    }
  };
  new MutationObserver((records) => {
    const changed = records.some(
      (record) =>
        (record.target instanceof Element && record.target.closest(ROWS) !== null) ||
        touchesRows(record.addedNodes) ||
        touchesRows(record.removedNodes),
    );
    if (!changed) return;
    scan();
    recollect();
  }).observe(document.body, { childList: true, subtree: true });
  scan();
}
