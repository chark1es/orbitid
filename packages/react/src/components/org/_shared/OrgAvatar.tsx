import { Avatar, AvatarFallback, AvatarImage } from "@orbitid/ui";
import { cn } from "@orbitid/ui";
import { initials } from "./utils";

export type OrgAvatarSize = "xs" | "sm" | "md" | "lg";

const SIZE_CLASSES: Record<OrgAvatarSize, string> = {
  xs: "size-6 text-2xs",
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-16 text-xl",
};

export interface OrgAvatarProps {
  /** Organization or user display name (drives the initials fallback). */
  name: string;
  imageUrl?: string | null;
  hasImage?: boolean;
  size?: OrgAvatarSize;
  className?: string;
}

/** Organization/user avatar with an initials fallback (shadcn `Avatar`). */
export function OrgAvatar({ name, imageUrl, hasImage, size = "sm", className }: OrgAvatarProps) {
  const showImage = Boolean(imageUrl) && hasImage !== false;
  return (
    <Avatar
      data-orbitid-element="organizationPreview"
      className={cn("shrink-0 rounded-md after:rounded-md", SIZE_CLASSES[size], className)}
      data-testid="org-avatar"
    >
      {showImage ? (
        <AvatarImage src={imageUrl as string} alt={name} className="rounded-md object-cover" />
      ) : null}
      <AvatarFallback className="rounded-md bg-muted font-medium text-muted-foreground">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
