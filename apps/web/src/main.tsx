import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { connectDesktop, subscribeWindowShows, windowShows } from "@/lib/desktop";
import { createQueryClient } from "@/lib/query";
import { exchangeLinkCode, takeLinkCode } from "@/lib/session";
import { initTheme } from "@/lib/theme";
import { checkForUpdates } from "@/lib/update-check";
import { dynamicActivate, initialLang } from "@/locales/i18n";
import { createRouter } from "@/router";
import "@/index.css";

initTheme();

// Before the router reads the address bar, so the code never enters its history.
const code = takeLinkCode(window.location, window.history);
const exchanged = code ? exchangeLinkCode(code) : Promise.resolve(null);

let router: ReturnType<typeof createRouter> | undefined;
const queryClient = createQueryClient(() => void router?.revalidate());
router = createRouter({ queryClient, exchanged });

connectDesktop((to) => void router?.navigate(to), checkForUpdates);
// Hidden while it feeds the desktop companion, the desktop app's window still runs this page, and
// an animation running would keep it drawing: index.css pauses them under the mark.
const markWindowShows = () => {
  document.documentElement.toggleAttribute("data-window-hidden", !windowShows());
};
subscribeWindowShows(markWindowShows);
// A page loaded while the window is hidden heard so before it listened.
markWindowShows();

// Rendered once a language is active: the viewer's, else English.
void dynamicActivate(initialLang()).then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            {router.element}
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </I18nProvider>
    </StrictMode>,
  );
});
