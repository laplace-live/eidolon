// Pictures: the outfits selfies redraw, the friends she can take one with, and how selfies are
// drawn. Her avatar is on Profile.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ImagePlusIcon, ImagesIcon, Trash2Icon, UserPlusIcon, UsersIcon } from "lucide-react";
import { type DragEvent, type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { SectionCard, SectionCardSkeleton } from "@/components/section-card";
import { SettingsCard } from "@/components/settings-form/settings-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type PersonaSummary, type ReferenceImage, type ReferenceKind, url } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { previewable, previewUrl, renamed, stemOf } from "./files";
import { LoadError } from "./parts";
import { draggingFiles, uploadProblem, useFilePicker, useRemove, useUpload } from "./pictures";
import { personaQueries } from "./queries";
import { CARD_PATHS } from "./sections";

const SHAPE: Record<ReferenceKind, string> = {
  // Outfits are whole figures, shown whole; friends are faces, filling the tile.
  outfits: "aspect-[3/4] object-contain",
  friends: "aspect-square object-cover",
};

function ImageGrid({
  persona,
  kind,
  images,
  version,
  removing,
  onRemove,
}: {
  readonly persona: string;
  readonly kind: ReferenceKind;
  readonly images: readonly ReferenceImage[];
  readonly version: number;
  readonly removing: boolean;
  readonly onRemove: (image: ReferenceImage) => void;
}) {
  const { t } = useLingui();
  const lang = useLang();
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {images.map((image) => {
        const src = url("GET /api/local/personas/:id/references/:kind/:name", {
          params: { id: persona, kind, name: image.name },
        });
        return (
          <li key={image.name} className="flex min-w-0 flex-col gap-2">
            {previewable(image.name) ? (
              <img
                src={`${src}?v=${version}`}
                alt={image.name}
                loading="lazy"
                className={cn("w-full rounded-lg border bg-muted/40", SHAPE[kind])}
              />
            ) : (
              <div
                className={cn(
                  "flex w-full items-center justify-center rounded-lg border bg-muted/40 p-3 text-center text-muted-foreground text-xs",
                  SHAPE[kind],
                )}
              >
                {t`No preview: only PNG, JPEG and WebP are shown here. Selfies still use it.`}
              </div>
            )}
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm" title={image.name}>
                  {kind === "friends" ? stemOf(image.name) : image.name}
                </p>
                <p className="text-muted-foreground text-xs">
                  {image.source === "template" ? t`Built in` : formatBytes(image.size, lang)}
                </p>
              </div>
              {image.source === "own" && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="-mt-0.5 -mr-1.5 text-muted-foreground"
                  aria-label={t({
                    message: `Remove ${ph({ name: image.name })}`,
                    context: "picture",
                  })}
                  disabled={removing}
                  onClick={() => onRemove(image)}
                >
                  <Trash2Icon />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A card of one kind of picture, which takes files dropped on it as well as picked. */
function PicturesCard({
  title,
  description,
  note,
  addLabel,
  addIcon,
  empty,
  multiple,
  busy,
  onFiles,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly note?: string;
  readonly addLabel: string;
  readonly addIcon: ReactNode;
  /** The empty state, while there are no pictures. */
  readonly empty: {
    readonly icon: ReactNode;
    readonly title: string;
    readonly body: string;
  } | null;
  readonly multiple: boolean;
  readonly busy: boolean;
  readonly onFiles: (files: File[]) => void;
  readonly children?: ReactNode;
}) {
  const picker = useFilePicker(onFiles, multiple);
  const [over, setOver] = useState(false);
  const add = (variant: "default" | "outline") => (
    <Button variant={variant} disabled={busy} onClick={picker.open}>
      {addIcon}
      {addLabel}
    </Button>
  );

  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0 && !busy) onFiles(multiple ? files : files.slice(0, 1));
  }

  return (
    <SectionCard
      title={title}
      description={description}
      // One add button at a time: the empty state carries it while there are no pictures.
      action={empty === null ? add("outline") : undefined}
      note={note}
    >
      {picker.input}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a pointer shortcut; the add button is the way in for everyone. */}
      <div
        onDragOver={(event) => {
          if (!draggingFiles(event)) return;
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={drop}
        className={cn(
          "rounded-xl outline-2 outline-transparent outline-offset-8 outline-dashed transition-colors",
          over && "outline-ring",
        )}
      >
        {empty === null ? (
          children
        ) : (
          <EmptyState
            icon={empty.icon}
            title={empty.title}
            description={empty.body}
            action={add("default")}
          />
        )}
      </div>
    </SectionCard>
  );
}

/** Asks a friend's name: their picture is named after them, which is how she knows who it is. */
function FriendDialog({
  file,
  uploading,
  onUpload,
  onClose,
}: {
  readonly file: File | null;
  readonly uploading: boolean;
  readonly onUpload: (file: File, name: string) => void;
  readonly onClose: () => void;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const id = useId();
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (file === null) return;
    setName(stemOf(file.name));
    const objectUrl = previewUrl(file);
    setPreview(objectUrl);
    if (objectUrl !== null) return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  const target = file === null ? "" : renamed(file.name, name);
  const problem = file === null || name.trim() === "" ? null : uploadProblem(file, target, lang);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (file !== null && name.trim() !== "" && problem === null) onUpload(file, target);
  }

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t`Add a Friend`}</DialogTitle>
            <DialogDescription>{t`The picture is saved under their name, which is how she knows who it is.`}</DialogDescription>
          </DialogHeader>
          {preview && (
            <img
              src={preview}
              alt=""
              className="mx-auto aspect-square w-40 rounded-xl border object-cover"
            />
          )}
          <Field data-invalid={problem !== null}>
            <FieldLabel htmlFor={id}>{t`Their Name`}</FieldLabel>
            <Input
              id={id}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={problem !== null}
              autoComplete="off"
              autoFocus
            />
            {problem ? (
              <FieldError>{problem}</FieldError>
            ) : (
              <FieldDescription className="break-all">{target}</FieldDescription>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={uploading || name.trim() === "" || problem !== null}>
              {uploading && <Spinner />}
              {t`Upload`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReferencesSection({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
  const lang = useLang();
  const references = useQuery(personaQueries(persona.id).references);
  // Bumped after each change, so pictures under an unchanged name load again.
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((n) => n + 1);
  const upload = useUpload(persona.id, bump);
  const remove = useRemove(persona.id, bump);
  const [friend, setFriend] = useState<File | null>(null);

  // One at a time: each gets its own toast, and the server one upload at a time.
  async function uploadOutfits(files: File[]) {
    for (const file of files) {
      const name = file.name.normalize("NFC");
      const problem = uploadProblem(file, name, lang);
      if (problem !== null) {
        toast.error(problem);
        continue;
      }
      try {
        await upload.mutateAsync({ kind: "outfits", name, file });
        toast.success(t`${name} uploaded.`);
      } catch {
        // useUpload's onError said why.
      }
    }
  }

  const selfies = (
    <SettingsCard
      scope="persona"
      persona={persona.id}
      paths={CARD_PATHS.selfie}
      title={t`Selfies`}
      description={t`The image model and how selfies are drawn.`}
    />
  );

  if (references.isPending) {
    return (
      <>
        <SectionCardSkeleton rows={1} footer={false} />
        <SectionCardSkeleton rows={1} footer={false} />
        {selfies}
      </>
    );
  }
  if (references.isError) {
    return (
      <>
        <LoadError error={references.error} />
        {selfies}
      </>
    );
  }
  const { outfits, friends } = references.data;

  return (
    <>
      <PicturesCard
        title={t`Outfits`}
        description={t`What she looks like in selfies. Each selfie redraws one outfit, picked by the hour.`}
        note={
          persona.template
            ? t`Outfits you add stay on this computer: deploying ${ph({ name: persona.name })} copies only her friends' pictures.`
            : undefined
        }
        addLabel={t`Add Pictures`}
        addIcon={<ImagePlusIcon />}
        empty={
          outfits.length > 0
            ? null
            : {
                icon: <ImagesIcon />,
                title: t`No outfits yet`,
                body: t`She can't take selfies without one. Add a picture of her, or drop one here.`,
              }
        }
        multiple
        busy={upload.isPending}
        onFiles={(files) => void uploadOutfits(files)}
      >
        <ImageGrid
          persona={persona.id}
          kind="outfits"
          images={outfits}
          version={version}
          removing={remove.isPending}
          onRemove={(image) => remove.mutate({ kind: "outfits", name: image.name })}
        />
      </PicturesCard>
      <PicturesCard
        title={t`Friends`}
        description={t`People she can take a selfie with: one picture each, named after them.`}
        addLabel={t`Add a Friend`}
        addIcon={<UserPlusIcon />}
        empty={
          friends.length > 0
            ? null
            : {
                icon: <UsersIcon />,
                title: t`No friends yet`,
                body: t`Add a picture of someone she can take a selfie with, or drop one here.`,
              }
        }
        multiple={false}
        busy={upload.isPending}
        onFiles={(files) => setFriend(files[0] ?? null)}
      >
        <ImageGrid
          persona={persona.id}
          kind="friends"
          images={friends}
          version={version}
          removing={remove.isPending}
          onRemove={(image) => remove.mutate({ kind: "friends", name: image.name })}
        />
      </PicturesCard>
      {selfies}
      <FriendDialog
        file={friend}
        uploading={upload.isPending}
        onClose={() => setFriend(null)}
        onUpload={(file, name) =>
          upload.mutate(
            { kind: "friends", name, file },
            {
              onSuccess: () => {
                setFriend(null);
                toast.success(t`${name} uploaded.`);
              },
            },
          )
        }
      />
    </>
  );
}
