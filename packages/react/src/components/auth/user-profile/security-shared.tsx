import type { OrbitUser } from "../_shared/w6";

export interface SectionProps {
  user: OrbitUser;
  refresh: () => Promise<void>;
  onError: (caught: unknown) => void;
  onNotice: (message: string) => void;
}


export function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}


export function formatDate(value: number | null | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}
