import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlusIcon, InfoIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { PersonaAvatar } from "@/components/avatar";
import { avatarChanged } from "@/components/avatar/version";
import { SettingsForm } from "@/components/settings-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastError } from "@/features/jobs/feedback";
import { formatBytes } from "@/features/jobs/format";
import { call, type PersonaSummary, type ReferenceImage, type ReferenceKind, url } from "@/lib/api";
import { type Lang, t as translate, useLang, useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import {
  IMAGE_EXTENSIONS,
  IMAGE_TYPES,
  imageProblem,
  MAX_IMAGE_BYTES,
  nameProblem,
  renamed,
  stemOf,
} from "./files";
import { LoadError, Section } from "./parts";
import { personaQueries } from "./queries";

const SELFIE_PATHS = [
  "selfie.model",
  "selfie.quality",
  "selfie.aspectRatio",
  "selfie.timeoutSeconds",
  "selfie.ttlSeconds",
  "selfie.references",
] as const;

const ACCEPT = [...IMAGE_TYPES, ...IMAGE_EXTENSIONS].join(",");

/** Why `file` can't be uploaded as `name`, in the viewer's language; null when it can. */
function uploadProblem(file: File, name: string, lang: Lang): string | null {
  const image = imageProblem(file);
  if (image === "type") return translate("studio.references.badType");
  if (image === "size") {
    return translate("studio.references.tooLarge", { max: formatBytes(MAX_IMAGE_BYTES, lang) });
  }
  return nameProblem(name, IMAGE_EXTENSIONS) === null
    ? null
    : translate("studio.references.badName", { name });
}

/** A file picker behind a button. */
function PickButton({
  label,
  icon,
  multiple = false,
  disabled,
  onFiles,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly multiple?: boolean;
  readonly disabled: boolean;
  readonly onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  function picked(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length > 0) onFiles(files);
  }
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple={multiple}
        className="hidden"
        onChange={picked}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {icon}
        {label}
      </Button>
    </>
  );
}

function useUpload(persona: string, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      kind,
      name,
      file,
    }: {
      kind: ReferenceKind | "avatar";
      name: string;
      file: File;
    }) =>
      kind === "avatar"
        ? call("PUT /api/local/personas/:id/avatar", { params: { id: persona }, body: file })
        : call("POST /api/local/personas/:id/references/:kind/:name", {
            params: { id: persona, kind, name },
            body: file,
          }),
    onSuccess: async (_image, { kind }) => {
      if (kind === "avatar") avatarChanged(persona);
      onDone();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: personaQueries(persona).references.queryKey }),
        queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
      ]);
    },
    onError: toastError,
  });
}

function useRemove(persona: string, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, name }: { kind: ReferenceKind | "avatar"; name: string }) =>
      kind === "avatar"
        ? call("DELETE /api/local/personas/:id/avatar", { params: { id: persona } })
        : call("DELETE /api/local/personas/:id/references/:kind/:name", {
            params: { id: persona, kind, name },
          }),
    onSuccess: async (_ok, { kind }) => {
      if (kind === "avatar") avatarChanged(persona);
      onDone();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: personaQueries(persona).references.queryKey }),
        queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
      ]);
    },
    onError: toastError,
  });
}

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
  const t = useT();
  const lang = useLang();
  if (images.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
        {t(`studio.references.${kind}Empty`)}
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      {images.map((image) => {
        const src = url("GET /api/local/personas/:id/references/:kind/:name", {
          params: { id: persona, kind, name: image.name },
        });
        return (
          <li key={image.name} className="flex flex-col gap-1.5">
            <img
              src={`${src}?v=${version}`}
              alt={image.name}
              loading="lazy"
              className="aspect-square w-full rounded-lg border bg-muted object-cover"
            />
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={image.name}>
                  {kind === "friends" ? stemOf(image.name) : image.name}
                </p>
                <p className="text-muted-foreground text-xs">
                  {image.source === "template"
                    ? t("studio.references.builtIn")
                    : formatBytes(image.size, lang)}
                </p>
              </div>
              {image.source === "own" && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("studio.references.remove", { name: image.name })}
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
  const t = useT();
  const lang = useLang();
  const id = useId();
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (file === null) return;
    setName(stemOf(file.name));
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
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
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("studio.references.friendTitle")}</DialogTitle>
            <DialogDescription>{t("studio.references.friendHelp")}</DialogDescription>
          </DialogHeader>
          {preview && (
            <img
              src={preview}
              alt=""
              className="mx-auto aspect-square w-40 rounded-lg border object-cover"
            />
          )}
          <Field data-invalid={problem !== null}>
            <FieldLabel htmlFor={id}>{t("studio.references.friendName")}</FieldLabel>
            <Input
              id={id}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            {problem ? (
              <FieldError>{problem}</FieldError>
            ) : (
              <FieldDescription>{target}</FieldDescription>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("studio.references.cancel")}
            </Button>
            <Button type="submit" disabled={uploading || name.trim() === "" || problem !== null}>
              {uploading && <Spinner />}
              {t("studio.references.upload")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReferencesTab({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const lang = useLang();
  const references = useQuery(personaQueries(persona.id).references);
  // Bumped after each change, so pictures under an unchanged name load again.
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((n) => n + 1);
  const upload = useUpload(persona.id, bump);
  const remove = useRemove(persona.id, bump);
  const [friend, setFriend] = useState<File | null>(null);

  // One at a time: each gets its own toast, and the server one upload at a time.
  async function uploadAll(kind: ReferenceKind | "avatar", files: File[]) {
    for (const file of files) {
      const name = file.name.normalize("NFC");
      // The avatar's name is the server's to choose, so only its type and size matter.
      const problem = uploadProblem(file, kind === "avatar" ? "avatar.png" : name, lang);
      if (problem !== null) {
        toast.error(problem);
        continue;
      }
      try {
        await upload.mutateAsync({ kind, name, file });
        toast.success(t("studio.references.uploaded", { name }));
      } catch {
        // useUpload's onError said why.
      }
    }
  }

  if (references.isPending) return <Skeleton className="h-96" />;
  if (references.isError) return <LoadError error={references.error} />;
  const { avatar, outfits, friends } = references.data;

  return (
    <div className="flex flex-col gap-6">
      {persona.template && (
        <Alert>
          <InfoIcon />
          <AlertTitle>{t("studio.references.localTitle")}</AlertTitle>
          <AlertDescription>
            {t("studio.references.localBody", { name: persona.name })}
          </AlertDescription>
        </Alert>
      )}
      <Section
        title={t("studio.references.avatarTitle")}
        description={t("studio.references.avatarHelp")}
      >
        <div className="flex flex-wrap items-center gap-4">
          <PersonaAvatar persona={persona} size="xl" />
          <div className="flex flex-wrap gap-2">
            <PickButton
              label={t(
                avatar ? "studio.references.avatarReplace" : "studio.references.avatarUpload",
              )}
              icon={<ImagePlusIcon />}
              disabled={upload.isPending}
              onFiles={(files) => void uploadAll("avatar", files.slice(0, 1))}
            />
            {avatar?.source === "own" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ kind: "avatar", name: avatar.name })}
              >
                <Trash2Icon />
                {t("studio.references.avatarRemove")}
              </Button>
            )}
          </div>
        </div>
      </Section>
      <Section
        title={t("studio.references.outfitsTitle")}
        description={t("studio.references.outfitsHelp")}
        action={
          <PickButton
            label={t("studio.references.add")}
            icon={<ImagePlusIcon />}
            multiple
            disabled={upload.isPending}
            onFiles={(files) => void uploadAll("outfits", files)}
          />
        }
      >
        <ImageGrid
          persona={persona.id}
          kind="outfits"
          images={outfits}
          version={version}
          removing={remove.isPending}
          onRemove={(image) => remove.mutate({ kind: "outfits", name: image.name })}
        />
      </Section>
      <Section
        title={t("studio.references.friendsTitle")}
        description={t("studio.references.friendsHelp")}
        action={
          <PickButton
            label={t("studio.references.addFriend")}
            icon={<UserPlusIcon />}
            disabled={upload.isPending}
            onFiles={(files) => setFriend(files[0] ?? null)}
          />
        }
      >
        <ImageGrid
          persona={persona.id}
          kind="friends"
          images={friends}
          version={version}
          removing={remove.isPending}
          onRemove={(image) => remove.mutate({ kind: "friends", name: image.name })}
        />
      </Section>
      <Section
        title={t("studio.references.selfieTitle")}
        description={t("studio.references.selfieHelp")}
      >
        <SettingsForm scope="persona" persona={persona.id} paths={SELFIE_PATHS} />
      </Section>
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
                toast.success(t("studio.references.uploaded", { name }));
              },
            },
          )
        }
      />
    </div>
  );
}
