// Runs sandboxed before each page in the window. It marks the page with the window controls it sits
// beside, before its first paint, for apps/web's [data-shell] styles and the shell pages' insets.
const shell = process.platform === "darwin" ? "mac" : "win";

// A preload runs before the parser has created <html>: the mark goes on as it's inserted.
new MutationObserver((_records, observer) => {
  if (document.documentElement === null) return;
  document.documentElement.dataset.shell = shell;
  observer.disconnect();
}).observe(document, { childList: true });
