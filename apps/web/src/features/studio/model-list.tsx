// How She Looks: her character models, which one is active, and importing more, picked from the
// files or a folder, or dropped on the card.
import { ph, plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  ChevronDownIcon,
  EllipsisIcon,
  FileIcon,
  FileUpIcon,
  FolderOpenIcon,
  FolderSearchIcon,
  PencilIcon,
  PersonStandingIcon,
  PowerOffIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ListCard, ListRow } from "@/components/list";
import { QuietBadge } from "@/components/quiet-badge";
import { SectionCard } from "@/components/section-card";
import { EnvBadge } from "@/components/settings-form/field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { UnavailableButton } from "@/components/unavailable-button";
import { useCallPresence } from "@/features/call/call-context";
import type { CharacterModel, CharacterModels, PersonaSummary } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { toastError } from "@/lib/feedback";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type Lang, useLang } from "@/locales/i18n";
import { MODEL_KIND_LABELS, NAME_PROBLEMS } from "./appearance-labels";
import { type ActiveModel, MAX_NAME, nameProblem } from "./model-draft";
import {
  MAX_MODEL_BYTES,
  MODEL_ACCEPT,
  type ModelFileProblem,
  ModelUpload,
  modelFileFrom,
  modelFileFromDrop,
} from "./model-files";
import {
  useActivateModel,
  useImportModel,
  useRemoveModel,
  useReplaceModelFile,
  useUpdateModel,
} from "./model-queries";
import { Hint } from "./parts";
import { draggingFiles } from "./pictures";

/** The upload limit, 200 MiB, as its round number: formatBytes, counting in thousands, says 209.7. */
function maxModelSize(lang: Lang): string {
  return new Intl.NumberFormat(lang, { style: "unit", unit: "megabyte" }).format(
    MAX_MODEL_BYTES / 1024 ** 2,
  );
}

/** Why nothing could be imported from what was picked, in the viewer's language. */
function fileProblemText(problem: ModelFileProblem, lang: Lang): string {
  switch (problem) {
    case "type":
      return t`Pick a .p2lrt file from PSD2Live, or the folder or zip of its web export.`;
    case "size":
      return t`A model can be up to ${ph({ max: maxModelSize(lang) })}.`;
    case "header":
      return t`That file isn't a PSD2Live model.`;
    case "none":
      return t`There's no .p2lrt model in it.`;
    case "several":
      return t`It holds more than one .p2lrt model. Import the one you want on its own.`;
    case "zip":
      return t`That zip can't be read here. Unzip it, then import the .p2lrt inside.`;
    case "read":
      return t`That file couldn't be read. Pick it again.`;
  }
}

/** What a picker is open for: a new model, or a new file for one of hers. */
type Target =
  | { readonly kind: "import" }
  | { readonly kind: "replace"; readonly model: CharacterModel };

/** Hidden inputs for a file and a folder, each opened for an import or, the file, a replacement. */
function usePickers(onPicked: (files: File[], target: Target) => void) {
  const { t } = useLingui();
  const file = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const target = useRef<Target>({ kind: "import" });
  // React's types lack webkitdirectory, which makes the input pick a folder.
  const asFolder = useCallback((input: HTMLInputElement | null) => {
    folder.current = input;
    input?.setAttribute("webkitdirectory", "");
  }, []);
  function picked(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length > 0) onPicked(files, target.current);
  }
  return {
    inputs: (
      <>
        <input
          ref={file}
          type="file"
          accept={MODEL_ACCEPT}
          aria-label={t`Model File`}
          className="hidden"
          onChange={picked}
        />
        <input
          ref={asFolder}
          type="file"
          aria-label={t`Model Folder`}
          className="hidden"
          onChange={picked}
        />
      </>
    ),
    openFile: (next: Target) => {
      target.current = next;
      file.current?.click();
    },
    openFolder: () => {
      target.current = { kind: "import" };
      folder.current?.click();
    },
  };
}

function ImportMenu({
  variant,
  busy,
  onFile,
  onFolder,
}: {
  readonly variant: "default" | "outline";
  readonly busy: boolean;
  readonly onFile: () => void;
  readonly onFolder: () => void;
}) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} disabled={busy}>
          {busy ? <Spinner /> : <FileUpIcon />}
          {t`Import a Model`}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-44">
        <DropdownMenuItem onSelect={onFile}>
          <FileIcon />
          {t`From a File`}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onFolder}>
          <FolderOpenIcon />
          {t`From a Folder`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RenameForm({
  name,
  pending,
  onRename,
  onCancel,
}: {
  readonly name: string;
  readonly pending: boolean;
  readonly onRename: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const [typed, setTyped] = useState(name);
  const problem = nameProblem(typed);
  // An empty name waits for its Save to go off, without a word.
  const shown = problem === null || problem === "empty" ? null : t(NAME_PROBLEMS[problem]);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (problem === null && !pending) onRename(typed.trim());
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t`Rename the Model`}</DialogTitle>
        <DialogDescription>{t`Only you see this name, here in the studio.`}</DialogDescription>
      </DialogHeader>
      <Field data-invalid={shown !== null}>
        <FieldLabel htmlFor={fieldId}>{t`Name`}</FieldLabel>
        <Input
          id={fieldId}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          maxLength={MAX_NAME}
          aria-invalid={shown !== null}
          autoComplete="off"
          autoFocus
        />
        {shown !== null && <FieldError>{shown}</FieldError>}
      </Field>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          {t`Cancel`}
        </Button>
        <Button type="submit" disabled={problem !== null || pending}>
          {pending && <Spinner />}
          {t`Save`}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ModelMenu({
  stoppable,
  busy,
  waiting,
  onRename,
  onReplace,
  onStop,
  onRemove,
  reveal,
}: {
  /** Active through her own setting, which clearing would change what she shows. */
  readonly stoppable: boolean;
  readonly busy: boolean;
  /** Why a new file waits, which the server would refuse now; null when it can be sent. */
  readonly waiting: string | null;
  readonly onRename: () => void;
  readonly onReplace: () => void;
  readonly onStop: () => void;
  readonly onRemove: () => void;
  /** The desktop app's Show in Finder or Explorer, as its label and action; null elsewhere. */
  readonly reveal: { readonly label: string; readonly run: () => void } | null;
}) {
  const { t } = useLingui();
  // A dialog opens once the menu has closed: open together, the two focus traps fight.
  const opening = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t`Model Options`}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-auto min-w-40"
        onCloseAutoFocus={(event) => {
          const next = opening.current;
          if (next === null) return;
          event.preventDefault();
          opening.current = null;
          next();
        }}
      >
        <DropdownMenuItem onSelect={() => (opening.current = onRename)}>
          <PencilIcon />
          {t`Rename`}
        </DropdownMenuItem>
        {/* A file picker needs the click itself, not the menu's closing after it. */}
        <DropdownMenuItem disabled={waiting !== null} onSelect={onReplace}>
          <FileUpIcon />
          {t`Replace File`}
        </DropdownMenuItem>
        {waiting !== null && (
          <p className="max-w-56 px-2 pb-1.5 text-muted-foreground text-xs">{waiting}</p>
        )}
        {reveal !== null && (
          <DropdownMenuItem onSelect={reveal.run}>
            <FolderSearchIcon />
            {reveal.label}
          </DropdownMenuItem>
        )}
        {stoppable && (
          <DropdownMenuItem onSelect={onStop}>
            <PowerOffIcon />
            {t`Stop Using`}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => (opening.current = onRemove)}>
          <Trash2Icon />
          {t({ message: "Remove", context: "model" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelRow({
  model,
  active,
  inherited,
  selected,
  busy,
  onActivate,
  menu,
}: {
  readonly model: CharacterModel;
  readonly active: boolean;
  /** Active through the environment's setting, not hers. */
  readonly inherited: boolean;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onActivate: () => void;
  readonly menu: ReactNode;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const { inventory } = model;
  const expressions = inventory.expressions.length;
  const clips = inventory.clips.length;
  const details = [
    formatBytes(model.size, lang),
    t`${plural(ph({ count: expressions }), { one: "# expression", other: "# expressions" })}`,
    t`${plural(ph({ count: clips }), { one: "# clip", other: "# clips" })}`,
  ];
  return (
    <ListRow
      current={selected}
      href={`?model=${encodeURIComponent(model.id)}`}
      leading={
        <span className="flex size-10 items-center justify-center rounded-full bg-muted">
          <PersonStandingIcon className="size-5" />
        </span>
      }
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="wrap-anywhere">{model.name}</span>
          {active && <Badge>{t`Active`}</Badge>}
          {active && inherited && <EnvBadge />}
          <QuietBadge>{t(MODEL_KIND_LABELS[model.kind])}</QuietBadge>
        </span>
      }
      description={details.join(" · ")}
      trailing={
        <>
          {!active && (
            <Button variant="outline" size="sm" disabled={busy} onClick={onActivate}>
              {t({ message: "Make Active", context: "model" })}
            </Button>
          )}
          {menu}
        </>
      }
    />
  );
}

export function ModelListCard({
  persona,
  list,
  active,
  selected,
  onImported,
}: {
  readonly persona: PersonaSummary;
  readonly list: CharacterModels;
  /** Where the active model comes from; null with none active, or while her setting loads. */
  readonly active: ActiveModel | null;
  /** The model shown below. */
  readonly selected: string | null;
  readonly onImported: (model: CharacterModel) => void;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const importing = useImportModel(persona.id);
  const replacing = useReplaceModelFile(persona.id);
  const activating = useActivateModel(persona.id);
  const removing = useRemoveModel(persona.id);
  const renaming = useUpdateModel(persona.id);
  // A file of up to 200 MiB is never picked only for the server to refuse it during a call.
  const { up } = useCallPresence();
  const waiting = up ? t`A call is in progress. Hang up first.` : null;
  const [reading, setReading] = useState(false);
  const [over, setOver] = useState(false);
  const [renamed, setRenamed] = useState<CharacterModel | null>(null);
  const [removed, setRemoved] = useState<CharacterModel | null>(null);
  const app = desktop();
  const revealModel = app?.revealModel;
  const revealOf = (model: CharacterModel) =>
    revealModel === undefined
      ? null
      : {
          label: app?.platform === "win32" ? t`Show in Explorer` : t`Show in Finder`,
          run: () => {
            revealModel({ persona: persona.id, model: model.id }).then((shown) => {
              if (!shown) toast.error(t`The model's file wasn't found.`);
            }, toastError);
          },
        };
  const busy =
    reading ||
    importing.isPending ||
    replacing.isPending ||
    activating.isPending ||
    removing.isPending;

  /** Removing `id` leaves her picture: it's the model she shows, and no other of hers takes over. */
  function removesLook(id: string): boolean {
    const fallback = active?.fallback ?? null;
    return id === list.active && (fallback === null || fallback === id);
  }

  async function take(reading: Promise<File | ModelFileProblem>, target: Target) {
    setReading(true);
    const picked = await reading;
    setReading(false);
    if (typeof picked === "string") {
      toast.error(fileProblemText(picked, lang));
      return;
    }
    const upload = new ModelUpload(picked);
    if (target.kind === "import") {
      importing.mutate(upload, {
        onSuccess: (model) => {
          toast.success(t`${ph({ name: model.name })} imported.`);
          onImported(model);
        },
      });
    } else {
      replacing.mutate(
        { model: target.model.id, upload },
        {
          onSuccess: (model) =>
            toast.success(t`${ph({ name: model.name })} now uses the new file.`),
        },
      );
    }
  }

  const pickers = usePickers((files, target) => void take(modelFileFrom(files), target));

  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    if (waiting !== null || busy || event.dataTransfer.files.length === 0) return;
    // Taken now: the drop's items are gone once its event returns.
    const dropped = {
      entries: [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry()),
      files: [...event.dataTransfer.files],
    };
    void take(modelFileFromDrop(dropped), { kind: "import" });
  }

  const empty = list.models.length === 0;
  const importMenu = (variant: "default" | "outline") =>
    waiting === null ? (
      <ImportMenu
        variant={variant}
        busy={busy}
        onFile={() => pickers.openFile({ kind: "import" })}
        onFolder={pickers.openFolder}
      />
    ) : (
      <UnavailableButton variant={variant} reason={waiting}>
        <FileUpIcon />
        {t`Import a Model`}
      </UnavailableButton>
    );

  return (
    <SectionCard
      title={t`How She Looks`}
      description={t`Animated 2D models of her, made in PSD2Live. The one you make active is how she looks.`}
      // One import button at a time: the empty state carries it while there are no models.
      action={empty ? undefined : importMenu("outline")}
    >
      {pickers.inputs}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping a model is a pointer shortcut; Import a Model is the way in for everyone. */}
      <div
        onDragOver={(event) => {
          if (!draggingFiles(event)) return;
          // Even while a call is up and the drop is ignored: left to it, the browser opens the file.
          event.preventDefault();
          if (waiting === null) setOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={drop}
        className={cn(
          "flex flex-col gap-4 rounded-xl outline-2 outline-transparent outline-offset-8 outline-dashed transition-colors",
          over && "outline-ring",
        )}
      >
        {empty ? (
          <EmptyState
            icon={<PersonStandingIcon />}
            title={t`No models yet`}
            description={
              waiting ??
              t`Import a .p2lrt from PSD2Live, or the folder or zip of its web export. You can drop one here too.`
            }
            action={importMenu("default")}
          />
        ) : (
          <>
            {waiting !== null ? (
              <Hint>{waiting}</Hint>
            ) : (
              list.active === null && (
                <Hint>
                  {t`None is active, so she shows her picture. Make one active to use it as her look.`}
                </Hint>
              )
            )}
            <ListCard label={t`Her Models`}>
              {list.models.map((model) => {
                const isActive = model.id === list.active;
                const own = isActive && active?.own === true;
                return (
                  <ModelRow
                    key={model.id}
                    model={model}
                    active={isActive}
                    inherited={isActive && active?.own === false}
                    selected={model.id === selected}
                    busy={busy}
                    onActivate={() =>
                      activating.mutate(model.id, {
                        onSuccess: () =>
                          toast.success(t`${ph({ name: model.name })} is now her active model.`),
                      })
                    }
                    menu={
                      <ModelMenu
                        // Not when the environment names it too: cleared, hers would leave it.
                        stoppable={own && active?.fallback !== model.id}
                        busy={busy}
                        waiting={waiting}
                        onRename={() => setRenamed(model)}
                        onReplace={() => pickers.openFile({ kind: "replace", model })}
                        onStop={() =>
                          activating.mutate(null, {
                            onSuccess: () =>
                              toast.success(
                                t`${ph({ name: model.name })} is no longer her active model.`,
                              ),
                          })
                        }
                        onRemove={() => setRemoved(model)}
                        reveal={revealOf(model)}
                      />
                    }
                  />
                );
              })}
            </ListCard>
          </>
        )}
      </div>
      <Dialog
        open={renamed !== null}
        onOpenChange={(open) => {
          if (!open && !renaming.isPending) setRenamed(null);
        }}
      >
        <DialogContent>
          {renamed !== null && (
            <RenameForm
              name={renamed.name}
              pending={renaming.isPending}
              onCancel={() => setRenamed(null)}
              onRename={(name) =>
                renaming.mutate(
                  { model: renamed.id, patch: { name } },
                  {
                    onSuccess: () => {
                      setRenamed(null);
                      toast.success(t`Renamed to ${name}.`);
                    },
                  },
                )
              }
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={removed !== null}
        onOpenChange={(open) => {
          if (!open && !removing.isPending) setRemoved(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Remove ${ph({ name: removed?.name ?? "" })}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {removed !== null && removesLook(removed.id)
                ? t`Its file and settings are deleted from her folder. It's her active model, so she shows her picture until you make another one active.`
                : t`Its file and settings are deleted from her folder.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing.isPending}>{t`Keep It`}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removing.isPending}
              onClick={(event) => {
                // Stays open until it is gone, so a failure is seen where it was asked for.
                event.preventDefault();
                if (removed === null) return;
                const { id, name } = removed;
                removing.mutate(id, {
                  onSuccess: () => {
                    setRemoved(null);
                    toast.success(t`${name} removed.`);
                  },
                });
              }}
            >
              {removing.isPending && <Spinner />}
              {t({ message: "Remove", context: "model" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
