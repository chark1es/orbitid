import { TriangleAlert } from "lucide-react";

export function FormError({ id, title, message }: { id: string; title: string; message: string }) {
  return (
    <div id={id} role="alert" className="rounded-md border border-signal/50 bg-signal/10 px-3 py-2.5">
      <p className="flex items-start gap-2 text-sm font-medium text-foreground">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
        {title}
      </p>
      <p className="mt-1 pl-6 text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
