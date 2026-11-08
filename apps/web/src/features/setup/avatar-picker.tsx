import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ImagePlusIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { monogram } from "@/components/avatar/monogram";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldError } from "@/components/ui/field";
import { imageProblem, MAX_IMAGE_BYTES, previewUrl } from "@/features/studio/files";
import { useFilePicker } from "@/features/studio/pictures";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";

/**
 * A new persona's optional avatar, picked before she exists: a preview, which shows her monogram
 * until a picture is picked, as her avatar would.
 */
export function AvatarPicker({
  file,
  onFile,
  name,
  disabled = false,
}: {
  readonly file: File | null;
  readonly onFile: (file: File | null) => void;
  /** Her short name or name, for the monogram. */
  readonly name: string;
  readonly disabled?: boolean;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const inputId = useId();
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<"type" | "size" | null>(null);

  useEffect(() => {
    const objectUrl = file === null ? null : previewUrl(file);
    setPreview(objectUrl);
    if (objectUrl !== null) return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const picker = useFilePicker(
    ([chosen]) => {
      if (chosen === undefined) return;
      const refused = imageProblem(chosen);
      setProblem(refused);
      if (refused === null) onFile(chosen);
    },
    false,
    inputId,
  );

  const letters = name.trim() === "" ? null : monogram(name);
  return (
    <fieldset className="flex min-w-0 items-center gap-5">
      <legend className="sr-only">
        {t`Avatar`} {t`(optional)`}
      </legend>
      {/* A click on the preview picks too; the button beside it is the one keyboards reach. */}
      <label
        htmlFor={inputId}
        aria-hidden
        className={cn(
          "group/avatar-pick relative shrink-0 rounded-full",
          disabled ? "pointer-events-none" : "cursor-pointer",
        )}
      >
        <Avatar className="size-16">
          {preview && <AvatarImage src={preview} alt="" />}
          <AvatarFallback className="font-medium text-xl">
            {letters || <ImagePlusIcon className="size-5" />}
          </AvatarFallback>
        </Avatar>
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-foreground/0 text-background opacity-0 transition-colors group-hover/avatar-pick:bg-foreground/45 group-hover/avatar-pick:opacity-100">
          <ImagePlusIcon className="size-5" />
        </span>
      </label>
      <div className="flex min-w-0 flex-col gap-2">
        <span aria-hidden className="font-medium text-sm leading-snug">
          {t`Avatar`} <span className="font-normal text-muted-foreground">{t`(optional)`}</span>
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={picker.open}
          >
            <ImagePlusIcon />
            {file ? t`Replace` : t`Upload`}
          </Button>
          {file && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setProblem(null);
                onFile(null);
              }}
            >
              {t`Remove`}
            </Button>
          )}
        </div>
        {problem === null ? (
          <FieldDescription>
            {t`A PNG, JPEG or WebP image, up to ${ph({ max: formatBytes(MAX_IMAGE_BYTES, lang) })}. Without one, her avatar shows her initials.`}
          </FieldDescription>
        ) : (
          <FieldError>
            {problem === "type"
              ? t`Pick a PNG, JPEG or WebP image.`
              : t`That image is over ${ph({ max: formatBytes(MAX_IMAGE_BYTES, lang) })}.`}
          </FieldError>
        )}
      </div>
      {picker.input}
    </fieldset>
  );
}
