import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { toastError } from "@/features/jobs/feedback";
import { call, type PersonaSummary } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { LoadError, SourceNote } from "./parts";
import { personaQueries } from "./queries";
import { TextEditor } from "./text-editor";

export function PromptTab({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const queryClient = useQueryClient();
  const query = personaQueries(persona.id).prompt;
  const prompt = useQuery(query);
  const save = useMutation({
    mutationFn: (text: string) =>
      call("PUT /api/local/personas/:id/prompt", { params: { id: persona.id }, body: { text } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(query.queryKey, saved);
      toast.success(t("studio.prompt.saved"));
    },
    onError: toastError,
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{t("studio.prompt.description")}</p>
      {prompt.isPending && <Skeleton className="h-[60vh]" />}
      {prompt.isError && <LoadError error={prompt.error} />}
      {prompt.data && (
        <>
          <SourceNote source={prompt.data.source} persona={persona} />
          {prompt.data.source === null && (
            <Alert>
              <AlertDescription>{t("studio.prompt.missing")}</AlertDescription>
            </Alert>
          )}
          <TextEditor
            value={prompt.data.text}
            label={t("studio.prompt.label")}
            placeholder={t("studio.prompt.placeholder")}
            saving={save.isPending}
            onSave={async (text) => (await save.mutateAsync(text)).text}
          />
        </>
      )}
    </div>
  );
}
