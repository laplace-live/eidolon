import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/section-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, call, type PersonaSummary } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { LoadError, SourceNote } from "./parts";
import { personaQueries } from "./queries";
import { TextEditor } from "./text-editor";

export function GlossarySection({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
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
      if (saved.errors.length > 0) toast.warning(t`Glossary saved, but it doesn't parse yet.`);
      else toast.success(t`Glossary saved.`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "invalid-toml") setRefused(error.message);
      else toastError(error);
    },
  });
  const errors = refused === null ? (glossary.data?.errors ?? []) : [refused];
  const card = {
    title: t`Glossary`,
    description: t`Names and terms Soniox should hear right when it transcribes this persona's videos: her name, her fans', recurring topics. It is TOML in the shape of Soniox's StructuredContext, and videos transcribed after you save use it.`,
  };

  if (glossary.isPending) {
    return (
      <SectionCard {...card}>
        <Skeleton className="h-[60vh] min-h-64" />
      </SectionCard>
    );
  }
  if (glossary.isError) {
    return (
      <SectionCard {...card}>
        <LoadError error={glossary.error} />
      </SectionCard>
    );
  }
  return (
    <TextEditor
      value={glossary.data.text}
      label={t`Glossary`}
      placeholder={t`terms = ["奶绿", "奶糖花"]`}
      saving={save.isPending}
      onSave={async (text) => (await save.mutateAsync(text)).text}
    >
      {({ area, status, buttons }) => (
        <SectionCard {...card} note={status} actions={buttons}>
          <SourceNote source={glossary.data.source} persona={persona} />
          {area}
          {errors.length > 0 && (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>
                {refused === null
                  ? t`This glossary doesn't parse`
                  : t`Not saved: this glossary doesn't parse`}
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
        </SectionCard>
      )}
    </TextEditor>
  );
}
