import { Avatar, AvatarFallback, AvatarImage, cn } from "@orbitid/ui";
import { initials } from "../../lib/format";

export function UserAvatar({
  name,
  imageUrl,
  size = "default",
  className,
}: {
  name: string;
  imageUrl?: string | null;
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  const sizeClass = size === "sm" ? "size-7" : size === "lg" ? "size-12 text-base" : "size-9 text-sm";
  return (
    <Avatar className={cn(sizeClass, className)}>
      {imageUrl ? <AvatarImage src={imageUrl} alt={name} /> : null}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}
