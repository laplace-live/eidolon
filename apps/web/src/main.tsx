import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initI18n } from "@/lib/i18n";
import { createQueryClient } from "@/lib/query";
import { exchangeLinkCode, takeLinkCode } from "@/lib/session";
import { initTheme } from "@/lib/theme";
import { catalogs } from "@/locales";
import { createRouter } from "@/router";
import "@/index.css";

initTheme();
initI18n(catalogs);

// Before the router reads the address bar, so the code never enters its history.
const code = takeLinkCode(window.location, window.history);
const exchanged = code ? exchangeLinkCode(code) : Promise.resolve(null);

let router: ReturnType<typeof createRouter> | undefined;
const queryClient = createQueryClient(() => void router?.revalidate());
router = createRouter({ queryClient, exchanged });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
