import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { toastError } from "@/features/jobs/feedback";
import { ApiError, call, type PersonaSummary } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { LoadError, SourceNote } from "./parts";
import { personaQueries } from "./queries";
import { TextEditor } from "./text-editor";

export function GlossaryTab({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const queryClient = useQueryClient();
  const query = personaQueries(persona.id).glossary;
  const glossary = useQuery(query);
  // A save the server refused for not parsing: the parser's message, since nothing was saved.
  const [refused, setRefused] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (text: string) =>
      call("PUT /api/local/personas/:id/glossary", { params: { id: persona.id }, body: { text } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(query.queryKey, saved);
      setRefused(null);
      if (saved.errors.length > 0) toast.warning(t("studio.glossary.savedWithErrors"));
      else toast.success(t("studio.glossary.saved"));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "invalid-toml") setRefused(error.message);
      else toastError(error);
    },
  });
  const errors = refused === null ? (glossary.data?.errors ?? []) : [refused];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{t("studio.glossary.description")}</p>
      {glossary.isPending && <Skeleton className="h-[60vh]" />}
      {glossary.isError && <LoadError error={glossary.error} />}
      {glossary.data && (
        <>
          <SourceNote source={glossary.data.source} persona={persona} />
          <TextEditor
            value={glossary.data.text}
            label={t("studio.glossary.label")}
            placeholder={t("studio.glossary.placeholder")}
            saving={save.isPending}
            onSave={async (text) => (await save.mutateAsync(text)).text}
          >
            {errors.length > 0 && (
              <Alert variant="destructive">
                <AlertTitle>
                  {t(refused === null ? "studio.glossary.errors" : "studio.glossary.refused")}
                </AlertTitle>
                <AlertDescription>
                  <ul className="flex flex-col gap-1">
                    {errors.map((error) => (
                      <li key={error} className="whitespace-pre-wrap break-words font-mono text-xs">
                        {error}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </TextEditor>
        </>
      )}
    </div>
  );
}
