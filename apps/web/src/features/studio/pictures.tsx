// Her pictures: the avatar at the root of her folder, outfits and friends under references/.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type DragEvent, useRef } from "react";
import { avatarChanged } from "@/components/avatar/version";
import { call, type ReferenceKind } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { formatBytes } from "@/lib/format";
import { type Lang, t as translate } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { IMAGE_EXTENSIONS, IMAGE_TYPES, imageProblem, MAX_IMAGE_BYTES, nameProblem } from "./files";
import { personaQueries } from "./queries";

type PictureKind = ReferenceKind | "avatar";

const ACCEPT = [...IMAGE_TYPES, ...IMAGE_EXTENSIONS].join(",");

/** Why `file` can't be uploaded as `name`, in the viewer's language; null when it can. */
export function uploadProblem(file: File, name: string, lang: Lang): string | null {
  const image = imageProblem(file);
  if (image === "type") return translate("studio.references.badType");
  if (image === "size") {
    return translate("studio.references.tooLarge", { max: formatBytes(MAX_IMAGE_BYTES, lang) });
  }
  return nameProblem(name, IMAGE_EXTENSIONS) === null
    ? null
    : translate("studio.references.badName", { name });
}

/** A hidden file input of the picture types, and a way to open it from any button. */
export function useFilePicker(onFiles: (files: File[]) => void, multiple = false) {
  const input = useRef<HTMLInputElement>(null);
  function picked(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length > 0) onFiles(files);
  }
  return {
    input: (
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple={multiple}
        className="hidden"
        onChange={picked}
      />
    ),
    open: () => input.current?.click(),
  };
}

/** Whether a drag carries files, as opposed to text or a link from the page. */
export function draggingFiles(event: DragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

/** After a picture changed: every avatar of hers reloads, and so do her list and status. */
function useChanged(persona: string, onDone?: () => void) {
  const queryClient = useQueryClient();
  return async (_result: unknown, { kind }: { kind: PictureKind }) => {
    if (kind === "avatar") avatarChanged(persona);
    onDone?.();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: personaQueries(persona).references.queryKey }),
      queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
    ]);
  };
}

export function useUpload(persona: string, onDone?: () => void) {
  const onSuccess = useChanged(persona, onDone);
  return useMutation({
    mutationFn: ({ kind, name, file }: { kind: PictureKind; name: string; file: File }) =>
      kind === "avatar"
        ? call("PUT /api/local/personas/:id/avatar", { params: { id: persona }, body: file })
        : call("POST /api/local/personas/:id/references/:kind/:name", {
            params: { id: persona, kind, name },
            body: file,
          }),
    onSuccess,
    onError: toastError,
  });
}

export function useRemove(persona: string, onDone?: () => void) {
  const onSuccess = useChanged(persona, onDone);
  return useMutation({
    mutationFn: ({ kind, name }: { kind: PictureKind; name: string }) =>
      kind === "avatar"
        ? call("DELETE /api/local/personas/:id/avatar", { params: { id: persona } })
        : call("DELETE /api/local/personas/:id/references/:kind/:name", {
            params: { id: persona, kind, name },
          }),
    onSuccess,
    onError: toastError,
  });
}
