// The images and text files the owner sends with a line: on its way in the composer, and in the
// log once sent, each served from the chat's files/.
import type { Attachment } from "@eidolon/chat";
import { useLingui } from "@lingui/react/macro";
import { FileTextIcon, ImageOffIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { OpenPicture } from "@/components/picture-viewer";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { chatFilePath } from "@/lib/chats";
import { desktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import type { DraftFile } from "./use-draft-files";

function SentImage({ src, single }: { readonly src: string; readonly single: boolean }) {
  const { t } = useLingui();
  const [failed, setFailed] = useState(false);
  const box = single ? "max-h-60 max-w-60" : "size-24";
  if (failed) {
    const label = t`This image couldn't be loaded`;
    return (
      <div
        role="img"
        aria-label={label}
        title={label}
        className="flex size-24 items-center justify-center rounded-xl bg-muted text-muted-foreground"
      >
        <ImageOffIcon className="size-5" />
      </div>
    );
  }
  const alt = t`Sent by you`;
  return (
    <OpenPicture src={src} alt={alt} className="block overflow-hidden rounded-xl">
      <img
        src={src}
        alt={alt}
        decoding="async"
        onError={() => setFailed(true)}
        className={cn(box, "bg-muted object-cover")}
      />
    </OpenPicture>
  );
}

function FileChip({ href, filename }: { readonly href?: string; readonly filename: string }) {
  const body = (
    <>
      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{filename}</span>
    </>
  );
  const chip = "flex max-w-60 items-center gap-1.5 rounded-xl border bg-card px-3 py-2 text-sm";
  if (href === undefined) return <div className={chip}>{body}</div>;
  // The desktop app has no tab to open it in: it saves it.
  return desktop() === null ? (
    <a href={href} target="_blank" rel="noreferrer" className={cn(chip, "hover:bg-accent")}>
      {body}
    </a>
  ) : (
    <a href={href} download={filename} className={cn(chip, "hover:bg-accent")}>
      {body}
    </a>
  );
}

/** The files a line of the owner's carried, above its words. */
export function SentFiles({
  chatId,
  files,
  failed = false,
}: {
  readonly chatId: string;
  readonly files: readonly Attachment[];
  readonly failed?: boolean;
}) {
  const images = files.filter((file) => file.kind === "image");
  const texts = files.filter((file) => file.kind === "file");
  return (
    <div className={cn("flex max-w-[80%] flex-col items-end gap-1.5", failed && "opacity-60")}>
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((file) => (
            <SentImage
              key={file.name}
              src={chatFilePath(chatId, file.name)}
              single={images.length === 1}
            />
          ))}
        </div>
      )}
      {texts.map((file) => (
        <FileChip
          key={file.name}
          href={chatFilePath(chatId, file.name)}
          filename={(file.kind === "file" && file.filename) || "file.txt"}
        />
      ))}
    </div>
  );
}

/** Files dragged anywhere over the page, dropped into the next line; nothing while `disabled`. */
export function DropFiles({
  disabled,
  onFiles,
}: {
  readonly disabled: boolean;
  readonly onFiles: (files: readonly File[]) => void;
}) {
  const { t } = useLingui();
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (disabled) return;
    // dragenter and dragleave fire for every element crossed on the way.
    let depth = 0;
    const carries = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
    const enter = (event: DragEvent) => {
      if (!carries(event)) return;
      depth += 1;
      setOver(true);
    };
    const leave = (event: DragEvent) => {
      if (!carries(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const hover = (event: DragEvent) => {
      if (carries(event)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      onFiles([...(event.dataTransfer?.files ?? [])]);
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", hover);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("dragover", hover);
      document.removeEventListener("drop", drop);
      setOver(false);
    };
  }, [disabled, onFiles]);
  if (!over) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-1 rounded-2xl border-2 border-dashed px-8 py-6 text-center">
        <p className="font-medium">{t`Drop to Attach`}</p>
        <p className="text-muted-foreground text-sm">
          {t`Images and text files go with your next message.`}
        </p>
      </div>
    </div>
  );
}

/** The files the next line carries, each with a way to take it back out. */
export function DraftFilesTray({
  files,
  onRemove,
}: {
  readonly files: readonly DraftFile[];
  readonly onRemove: (key: number) => void;
}) {
  const { t } = useLingui();
  if (files.length === 0) return null;
  return (
    <ul aria-label={t`Attachments`} className="flex flex-wrap gap-2">
      {files.map((file) => (
        <li key={file.key} className="relative">
          {file.preview !== null ? (
            <img
              src={file.preview}
              alt={file.filename}
              className="size-16 rounded-lg border bg-muted object-cover"
            />
          ) : (
            <FileChip filename={file.filename} />
          )}
          {file.attachment === null && (
            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
              <Spinner aria-label={t`Uploading`} />
            </div>
          )}
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="-top-2 -right-2 absolute size-5 rounded-full shadow-sm"
            aria-label={t`Remove Attachment`}
            onClick={() => onRemove(file.key)}
          >
            <XIcon className="size-3" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
