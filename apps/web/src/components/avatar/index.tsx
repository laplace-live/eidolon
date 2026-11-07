// A persona's picture: avatar.{png,jpg,jpeg,webp} at the root of her folder, else a monogram of
// her short name. The image goes through the session cookie, which an <img> sends on its own.
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { monogram } from "./monogram";
import { avatarSrc, useAvatarVersion } from "./version";

const SIZES = {
  xs: ["size-6", "text-[0.625rem]"],
  sm: ["size-8", "text-xs"],
  md: ["size-10", "text-sm"],
  lg: ["size-16", "text-xl"],
  xl: ["size-24", "text-3xl"],
} as const;

export type PersonaAvatarSize = keyof typeof SIZES;

export interface PersonaAvatarProps {
  readonly persona: { readonly id: string; readonly name: string; readonly shortName: string };
  /** xs 24 px, sm 32, md 40, lg 64, xl 96. */
  readonly size?: PersonaAvatarSize;
  /**
   * What a screen reader says for it. Without one it is decorative, as beside her name, where it
   * would only repeat it.
   */
  readonly alt?: string;
  readonly className?: string;
}

export function PersonaAvatar({ persona, size = "md", alt, className }: PersonaAvatarProps) {
  const [box, text] = SIZES[size];
  const version = useAvatarVersion(persona.id);
  return (
    <Avatar
      className={cn(box, className)}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      <AvatarImage key={`${persona.id}:${version}`} src={avatarSrc(persona.id, version)} alt="" />
      <AvatarFallback className={cn("font-medium", text)}>
        {monogram(persona.shortName || persona.name)}
      </AvatarFallback>
    </Avatar>
  );
}
