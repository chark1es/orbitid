import { Card, CardContent, Skeleton } from "@orbitid/ui";
import { ComponentRoot } from "./component-root";

/**
 * Shimmer placeholder shown until the SDK has loaded the environment and client. It renders inside the component
 * root, so a forced scheme, the branding and `appearance.variables` apply from the first frame.
 */
export function AuthLoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <ComponentRoot
      component="auth-loading"
      className="flex w-full items-center justify-center px-4 py-6"
      aria-busy="true"
      aria-label={label}
    >
      <Card className="w-full max-w-[25rem] gap-0 rounded-xl py-0 shadow-card">
        <CardContent className="flex flex-col gap-4 px-8 py-8">
          <Skeleton className="mx-auto size-9 rounded-full" />
          <Skeleton className="mx-auto h-5 w-40" />
          <Skeleton className="h-4 w-56 self-center" />
          <Skeleton className="mt-2 h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    </ComponentRoot>
  );
}
