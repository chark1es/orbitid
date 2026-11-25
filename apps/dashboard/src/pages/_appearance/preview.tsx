import type { CSSProperties } from "react";
import { Button, Card, CardContent, CardHeader, Input, Label, OrbitMark, Separator, cn } from "@orbitid/ui";
import { resolveAppearanceLayers, resolveElementClass } from "@orbitid/react";
import { PRESETS, draftVariables, type AppearanceDraft } from "./draft";

export type PreviewScheme = "light" | "dark";

/**
 * A static sign-in card drawn with the same primitives, tokens and classes as the prebuilt `<SignIn>`, driven by the
 * draft branding and playground values. Nothing in it is interactive.
 */
export function BrandingPreview({
  scheme,
  appName,
  brandFill,
  draft,
}: {
  scheme: PreviewScheme;
  appName: string;
  /** The brand color as the components would use it (dark brand colors fall back on a dark surface). */
  brandFill: string | null;
  draft: AppearanceDraft;
}) {
  const preset = PRESETS[draft.preset];
  const resolved = resolveAppearanceLayers([
    { baseTheme: preset ?? undefined, variables: draftVariables(draft, brandFill ?? undefined) },
  ]);
  const cardClass = resolveElementClass(
    resolved.elements.cardBox,
    "w-full max-w-[22rem] gap-0 overflow-hidden rounded-xl py-0 shadow-card",
  );

  return (
    <div
      data-testid="branding-preview"
      data-scheme={scheme}
      inert
      className={cn(
        "orbitid-component flex justify-center rounded-lg border border-border bg-background px-4 py-8 text-foreground transition-colors duration-200 motion-reduce:transition-none sm:py-10",
        scheme === "dark" ? "dark" : "light",
      )}
      style={resolved.cssVariables as CSSProperties}
    >
      <Card className={cardClass}>
        <CardHeader className="justify-items-center gap-0 px-7 pt-7 pb-5 text-center">
          <OrbitMark color="var(--primary)" className="mb-4 size-9" />
          <p className="text-base leading-snug font-heading tracking-[-0.01em]">Sign in to {appName || "your application"}</p>
          <p className="mt-1 text-sm text-muted-foreground">Welcome back. Sign in to continue.</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-7 pb-7">
          <Button type="button" variant="outline" tabIndex={-1} className="h-9 w-full gap-2.5 shadow-xs">
            <GoogleGlyph />
            Continue with Google
          </Button>
          <div className="flex items-center gap-3" role="presentation">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">or</span>
            <Separator className="flex-1" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="preview-email" className="text-sm font-medium">
              Email address
            </Label>
            <Input id="preview-email" tabIndex={-1} readOnly placeholder="you@example.com" />
          </div>
          <Button type="button" tabIndex={-1} className="w-full">
            Continue
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            No account? <span className="font-medium text-primary">Sign up</span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}
