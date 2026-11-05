import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { call, url } from "@/lib/api";
import { cn } from "@/lib/utils";
import { monogram } from "./format";

export interface PersonaFace {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
}

/** The persona's references/avatar.* when there is one, else a monogram of the short name. */
export function PersonaAvatar({
  persona,
  size = "default",
  speaking = false,
  className,
}: {
  readonly persona: PersonaFace;
  readonly size?: "default" | "sm" | "lg";
  readonly speaking?: boolean;
  readonly className?: string;
}) {
  const references = useQuery({
    queryKey: ["personas", persona.id, "references"],
    queryFn: ({ signal }) =>
      call("GET /api/local/personas/:id/references", { params: { id: persona.id }, signal }),
    retry: false,
  });
  const hasPicture = references.data?.avatar != null;
  return (
    <Avatar
      size={size}
      className={cn(
        "transition-shadow",
        speaking && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        className,
      )}
    >
      {hasPicture && (
        <AvatarImage
          src={url("GET /api/local/personas/:id/avatar", { params: { id: persona.id } })}
          alt=""
        />
      )}
      <AvatarFallback>{monogram(persona.shortName, persona.name)}</AvatarFallback>
    </Avatar>
  );
}
