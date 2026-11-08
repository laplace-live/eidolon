// A role's model: a searchable list of what the account's provider lists right now, where it lists
// any; otherwise a plain field for the id, saying why there is no list.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { modelsQuery } from "@/lib/accounts";
import { type Category, providerById, providerName } from "@/lib/providers";
import { cn } from "@/lib/utils";

export interface ModelPickerProps {
  readonly id: string;
  /** The account the role runs on; null while none fills it. */
  readonly account: string | null;
  /** Its provider, for what a missing list says. */
  readonly provider: string | null;
  readonly category: Category;
  readonly draft: string;
  /** What applies while the draft is empty; null when the provider needs one named. */
  readonly fallback: string | null;
  readonly invalid: boolean;
  readonly locked: boolean;
  readonly className?: string;
  readonly onDraft: (draft: string) => void;
}

export function ModelPicker({
  id,
  account,
  provider,
  category,
  draft,
  fallback,
  invalid,
  locked,
  className,
  onDraft,
}: ModelPickerProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const listing = useQuery({
    ...modelsQuery(account ?? "", category),
    enabled: account !== null,
  });
  const placeholder = fallback ?? t`Enter a model id`;
  const mono = "font-mono md:text-[0.8125rem]";
  const models = listing.data?.status === "ok" ? listing.data.models : [];

  if (models.length === 0) {
    const status = listing.data?.status;
    const browse =
      provider === null ? undefined : providerById(provider)?.offers[category]?.modelsUrl;
    const hint =
      listing.isPending && account !== null
        ? t`Asking the provider for its models…`
        : status === "no-key"
          ? t`Add this account's key to see its models; until then, type a model id.`
          : status === "refused"
            ? t`${ph({ provider: providerName(provider) })} refused this account's key: check it in Settings → Providers, or type the model id.`
            : status === "failed"
              ? t`Couldn't list the models (${ph({ reason: listing.data?.message ?? "" })}): type the model id.`
              : status === "unlisted"
                ? t`${ph({ provider: providerName(provider) })} doesn't list its models here: type the model id.`
                : null;
    return (
      <div className="flex flex-col gap-1.5">
        <Input
          id={id}
          disabled={locked}
          aria-invalid={invalid}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          className={cn(mono, !fallback && "placeholder:font-sans", className)}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
        />
        {hint && (
          <p className="text-muted-foreground text-xs">
            {hint}
            {browse && (
              <>
                {" "}
                <a
                  href={browse}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-4 hover:text-primary"
                >
                  {t`Browse ${ph({ provider: providerName(provider) })}'s models`}
                </a>
              </>
            )}
          </p>
        )}
      </div>
    );
  }

  const typed = search.trim();
  const unlisted = typed !== "" && !models.some((model) => model.id === typed);
  const choose = (value: string) => {
    onDraft(value);
    setOpen(false);
    setSearch("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          disabled={locked}
          className={cn(
            "h-9 w-full justify-between px-3 font-normal",
            mono,
            !draft && "text-muted-foreground",
            !draft && !fallback && "font-sans",
            className,
          )}
        >
          <span className="truncate">{draft || placeholder}</span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={t`Search models`} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{t`No model by that name.`}</CommandEmpty>
            {(draft !== "" || unlisted) && (
              <CommandGroup>
                {draft !== "" && (
                  <CommandItem value="\u0000default" onSelect={() => choose("")}>
                    {fallback ? t`Default (${ph({ value: fallback })})` : t`Default`}
                  </CommandItem>
                )}
                {unlisted && (
                  <CommandItem value={`\u0000typed ${typed}`} onSelect={() => choose(typed)}>
                    {t`Use “${ph({ model: typed })}”`}
                  </CommandItem>
                )}
              </CommandGroup>
            )}
            <CommandGroup heading={t`${ph({ provider: providerName(provider) })}'s Models`}>
              {models.map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={model.name === undefined ? undefined : [model.name]}
                  data-checked={model.id === draft}
                  onSelect={() => choose(model.id)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-[0.8125rem]">{model.id}</span>
                    {model.name && (
                      <span className="truncate text-muted-foreground text-xs">{model.name}</span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
