export default function Loading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-live="polite">
      <div className="space-y-3 border-b pb-5">
        <div className="h-7 w-56 animate-pulse rounded-sm bg-muted" />
        <div className="h-4 w-full max-w-[52ch] animate-pulse rounded-sm bg-muted" />
      </div>
      <div className="space-y-3">
        <div className="h-4 w-32 animate-pulse rounded-sm bg-muted" />
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="h-9 w-full animate-pulse rounded-sm bg-muted/70" />
        ))}
      </div>
      <p className="sr-only">Loading the page from the instance.</p>
    </div>
  );
}
