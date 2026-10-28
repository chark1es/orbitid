import { Card, CardContent, Skeleton, cn } from "@orbitid/ui";

/** Shimmer placeholder shown until the SDK has loaded the environment and client. */
export function AuthLoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex w-full items-center justify-center px-4 py-6" aria-busy="true" aria-label={label}>
      <Card className="w-full max-w-[25rem]">
        <CardContent className="flex flex-col gap-4 p-6">
          <Skeleton className="mx-auto size-10 rounded-full" />
          <Skeleton className={cn("mx-auto h-5 w-40")} />
          <Skeleton className="h-4 w-56 self-center" />
          <Skeleton className="mt-2 h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
