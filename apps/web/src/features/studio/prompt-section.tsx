import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SectionCard } from "@/components/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { call, type PersonaSummary } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { Hint, LoadError, SourceNote } from "./parts";
import { personaQueries } from "./queries";
import { TextEditor } from "./text-editor";

export function PromptSection({ persona }: { readonly persona: PersonaSummary }) {
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
  // Not titled with the editor's label, which getByLabel would then find twice.
  const card = { title: t("studio.prompt.title"), description: t("studio.prompt.description") };

  if (prompt.isPending) {
    return (
      <SectionCard {...card}>
        <Skeleton className="h-[60vh] min-h-64" />
      </SectionCard>
    );
  }
  if (prompt.isError) {
    return (
      <SectionCard {...card}>
        <LoadError error={prompt.error} />
      </SectionCard>
    );
  }
  return (
    <TextEditor
      value={prompt.data.text}
      label={t("studio.prompt.label")}
      placeholder={t("studio.prompt.placeholder")}
      saving={save.isPending}
      onSave={async (text) => (await save.mutateAsync(text)).text}
    >
      {({ area, status, buttons }) => (
        <SectionCard {...card} note={status} actions={buttons}>
          <SourceNote source={prompt.data.source} persona={persona} />
          {prompt.data.source === null && <Hint>{t("studio.prompt.missing")}</Hint>}
          {area}
        </SectionCard>
      )}
    </TextEditor>
  );
}
