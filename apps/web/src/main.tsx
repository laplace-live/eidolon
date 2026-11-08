import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createQueryClient } from "@/lib/query";
import { exchangeLinkCode, takeLinkCode } from "@/lib/session";
import { initTheme } from "@/lib/theme";
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

// Rendered once a language is active: the viewer's, else English.
void dynamicActivate(initialLang()).then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <RouterProvider router={router} />
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </I18nProvider>
    </StrictMode>,
  );
});
