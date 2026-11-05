import { ImageOffIcon } from "lucide-react";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A selfie the bot sent, in a box reserved at the 3:4 the bot renders, so the transcript doesn't
 * jump when it loads. The bot keeps a selfie for 10 minutes, after which it 404s.
 */
export function SelfieImage({ path, alt }: { readonly path: string; readonly alt: string }) {
  const t = useT();
  const [state, setState] = useState<"loading" | "loaded" | "expired">("loading");
  return (
    <div className="relative aspect-3/4 w-40 shrink-0 overflow-hidden rounded-xl bg-muted sm:w-48">
      {state === "expired" ? (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center text-xs text-muted-foreground">
          <ImageOffIcon className="size-5" />
          {t("call.selfie.expired")}
        </div>
      ) : (
        <a href={path} target="_blank" rel="noreferrer" className="block size-full">
          <img
            src={path}
            alt={alt}
            decoding="async"
            onLoad={() => setState("loaded")}
            onError={() => setState("expired")}
            className={cn("size-full object-cover", state === "loading" && "opacity-0")}
          />
        </a>
      )}
      {state === "loading" && <Skeleton className="absolute inset-0 rounded-none" />}
    </div>
  );
}
