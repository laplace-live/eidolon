// A persona's picture: references/avatar.{png,jpg,webp} in her folder, else a monogram of her
// short name. The image goes through the session cookie, which an <img> sends on its own.
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { url } from "@/lib/api";
import { cn } from "@/lib/utils";
import { monogram } from "./monogram";

const SIZES = {
  sm: ["size-8", "text-xs"],
  md: ["size-12", "text-base"],
  lg: ["size-20", "text-2xl"],
  xl: ["size-28", "text-3xl"],
} as const;

export interface PersonaAvatarProps {
  readonly persona: { readonly id: string; readonly name: string; readonly shortName: string };
  readonly size?: keyof typeof SIZES;
  /** Changes when the picture does, so the browser fetches the new one. */
  readonly version?: string | number;
  readonly className?: string;
}

export function PersonaAvatar({ persona, size = "md", version, className }: PersonaAvatarProps) {
  const [box, text] = SIZES[size];
  const src = url("GET /api/local/personas/:id/avatar", { params: { id: persona.id } });
  return (
    <Avatar className={cn(box, className)}>
      <AvatarImage
        key={`${persona.id}:${version ?? ""}`}
        src={version === undefined ? src : `${src}?v=${encodeURIComponent(version)}`}
        alt={persona.name}
      />
      <AvatarFallback className={cn("font-medium", text)}>
        {monogram(persona.shortName || persona.name)}
      </AvatarFallback>
    </Avatar>
  );
}
