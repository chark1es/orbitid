import { Skeleton, cn } from "@orbitid/ui";

/** Loading a page: the title row and the ruled blocks that will replace it. Never a spinner. */
export function PageSkeleton({
  rows = 3,
  label = "Loading",
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("w-full space-y-8", className)} aria-busy="true" aria-label={label} role="status">
      <div className="space-y-2 border-b border-border pb-4">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="space-y-3 border-t border-border pt-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
    </div>
  );
}

/** Loading a single form page such as sign-in: the controls, not a spinner over content. */
export function FormSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label={label} role="status">
      <div className="space-y-2">
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-4 w-2/3 max-w-sm" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-[34px] w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-[34px] w-full" />
        <Skeleton className="h-[34px] w-32" />
      </div>
    </div>
  );
}
