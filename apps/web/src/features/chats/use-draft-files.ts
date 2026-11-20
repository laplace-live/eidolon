// The files a line will carry, from the moment they are picked, pasted or dropped: each is sent to
// the chat at once, as it is, and the server makes it ready and keeps it, so a send only names them.
import { type Attachment, MAX_LINE_FILES } from "@eidolon/chat";
import { chatFileKind } from "@laplace.live/eidolon-sdk";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { previewUrl } from "@/features/studio/files";
import { ApiError } from "@/lib/api";
import { uploadChatFile } from "@/lib/chats";
import { toastError } from "@/lib/feedback";

/** The pictures a draft shows: the types the server takes. */
const PREVIEW_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface DraftFile {
  readonly key: number;
  /** What the owner's file was called. */
  readonly filename: string;
  /** An image's object URL, while it is a draft; null for a text file or a type not shown. */
  readonly preview: string | null;
  /** Null until it is kept in the chat. */
  readonly attachment: Attachment | null;
}

export interface DraftFiles {
  readonly files: readonly DraftFile[];
  /** Every file is kept in the chat, so the line can go. */
  readonly ready: boolean;
  add(files: readonly File[]): void;
  remove(key: number): void;
  /** The kept files, for a line that takes them; the drafts are cleared. */
  take(): readonly Attachment[];
}

/** The attachments a line of `drafts` carries: each kept one, once. */
export function lineAttachments(drafts: readonly DraftFile[]): Attachment[] {
  const kept: Attachment[] = [];
  for (const { attachment } of drafts) {
    // The same file picked twice is kept under one name, and POST messages refuses a line that
    // names one twice.
    if (attachment !== null && !kept.some(({ name }) => name === attachment.name)) {
      kept.push(attachment);
    }
  }
  return kept;
}

/**
 * The files of `picked` a line takes, with their kinds, up to `room` of them; the ones of a kind
 * it can't take, which leave the room to the rest; and whether more were taken than fit.
 */
export function pickedFiles(
  picked: readonly File[],
  room: number,
): {
  readonly taken: readonly { readonly file: File; readonly kind: "image" | "file" }[];
  readonly unsupported: readonly File[];
  readonly over: boolean;
} {
  const taken: { file: File; kind: "image" | "file" }[] = [];
  const unsupported: File[] = [];
  for (const file of picked) {
    const kind = chatFileKind(file);
    if (kind === null) unsupported.push(file);
    else taken.push({ file, kind });
  }
  return { taken: taken.slice(0, Math.max(0, room)), unsupported, over: taken.length > room };
}

let keys = 0;

/** The files the next line of chat `chatId` carries. */
export function useDraftFiles(chatId: string): DraftFiles {
  const { t } = useLingui();
  const [files, setFiles] = useState<readonly DraftFile[]>([]);
  const current = useRef(files);
  current.current = files;

  const forget = useCallback((gone: readonly DraftFile[]) => {
    for (const file of gone) if (file.preview !== null) URL.revokeObjectURL(file.preview);
  }, []);

  // Another chat starts with none; leaving drops the previews.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId only triggers it.
  useEffect(() => {
    return () => {
      forget(current.current);
      setFiles([]);
    };
  }, [chatId, forget]);

  const refused = useCallback(
    (filename: string, problem: "too-large" | "unsupported") => {
      if (problem === "too-large") {
        toast.error(t`${filename} is too large to send`, {
          description: t`An image goes up to 50 MB, a text file up to 1 MB.`,
        });
      } else {
        toast.error(t`${filename} can't be sent`, {
          description: t`Send a PNG, JPEG, WebP or GIF picture, or a text file in UTF-8.`,
        });
      }
    },
    [t],
  );

  const add = useCallback(
    (picked: readonly File[]) => {
      const { taken, unsupported, over } = pickedFiles(
        picked,
        MAX_LINE_FILES - current.current.length,
      );
      for (const file of unsupported) refused(file.name, "unsupported");
      if (over) {
        const count = MAX_LINE_FILES;
        toast.error(t`A message holds up to ${count} files`, {
          description: t`Send the rest with the next one.`,
        });
      }
      for (const { file, kind } of taken) {
        const key = ++keys;
        const preview = previewUrl(file, PREVIEW_TYPES);
        const draft: DraftFile = { key, filename: file.name, preview, attachment: null };
        setFiles((list) => [...list, draft]);
        const drop = () => {
          setFiles((list) => list.filter((each) => each.key !== key));
          if (preview !== null) URL.revokeObjectURL(preview);
        };
        // A text file goes as text whatever the browser typed it; anything else, as an image.
        const sent = kind === "file" ? new Blob([file], { type: "text/plain" }) : file;
        void uploadChatFile(chatId, sent, kind === "file" ? file.name : undefined)
          .then((attachment) => {
            setFiles((list) =>
              list.map((each) => (each.key === key ? { ...each, attachment } : each)),
            );
          })
          .catch((error: unknown) => {
            drop();
            if (error instanceof ApiError && error.code === "payload-too-large") {
              refused(file.name, "too-large");
            } else if (error instanceof ApiError && error.code === "unsupported-media-type") {
              refused(file.name, "unsupported");
            } else toastError(error);
          });
      }
    },
    [chatId, refused, t],
  );

  const remove = useCallback(
    (key: number) => {
      const gone = current.current.filter((file) => file.key === key);
      forget(gone);
      setFiles((list) => list.filter((file) => file.key !== key));
    },
    [forget],
  );

  const take = useCallback(() => {
    const kept = lineAttachments(current.current);
    forget(current.current);
    setFiles([]);
    return kept;
  }, [forget]);

  return {
    files,
    ready: files.every((file) => file.attachment !== null),
    add,
    remove,
    take,
  };
}
