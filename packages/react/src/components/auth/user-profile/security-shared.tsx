import type { ReactNode } from "react";
import type { OrbitUser } from "../_shared/w6";
import { useElementProps } from "../../../appearance";

export interface SectionProps {
  user: OrbitUser;
  refresh: () => Promise<void>;
  onError: (caught: unknown) => void;
  onNotice: (message: string) => void;
}


export function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <ProfileSectionTitle>{title}</ProfileSectionTitle>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

/** One section of a profile page (`profileSection`). */
export function ProfileSection({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  const ep = useElementProps();
  return (
    <section {...ep("profileSection", className)} data-orbit-section={id}>
      {children}
    </section>
  );
}

/** A section's title (`profileSectionTitle`). */
export function ProfileSectionTitle({ children }: { children: ReactNode }) {
  const ep = useElementProps();
  return <h2 {...ep("profileSectionTitle", "text-sm font-heading")}>{children}</h2>;
}


export function formatDate(value: number | null | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}
