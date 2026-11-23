import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn } from "@orbitid/ui";
import type { SocialProviderView } from "./environment";
import { ProviderIcon } from "./provider-icon";
import { useElementClasses, usePortalClass } from "./appearance";
import { useAuthRuntime } from "./w6";

export interface SocialButtonsProps {
  providers: SocialProviderView[];
  onSelect: (provider: SocialProviderView) => void;
  variant?: "blockButton" | "iconButton" | "auto";
  disabled?: boolean;
  lastUsedStrategy?: string | null;
  className?: string;
}

/** Social provider picker, driven entirely by `environment.user_settings.social`. */
export function SocialButtons({
  providers,
  onSelect,
  variant = "auto",
  disabled,
  lastUsedStrategy,
  className,
}: SocialButtonsProps) {
  const portalClass = usePortalClass();
  const { t } = useAuthRuntime();
  const { el, appearance } = useElementClasses();
  if (providers.length === 0) return null;

  const resolvedVariant =
    variant === "auto"
      ? (appearance.layout?.socialButtonsVariant as SocialButtonsProps["variant"]) ??
        (providers.length > 3 ? "iconButton" : "blockButton")
      : variant;

  const anyLastUsed = providers.some(
    (provider) => lastUsedStrategy === provider.strategy || lastUsedStrategy === provider.id,
  );

  if (resolvedVariant === "iconButton") {
    return (
      <TooltipProvider delayDuration={200}>
        <div
          role="group"
          aria-label={t("common.continue")}
          className={cn("flex flex-wrap items-center justify-center gap-2", el("socialButtons"), className)}
          data-orbit-element="socialButtons"
        >
          {providers.map((provider) => {
            const lastUsed = lastUsedStrategy === provider.strategy || lastUsedStrategy === provider.id;
            return (
              <Tooltip key={provider.id}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={disabled}
                    aria-label={lastUsed ? `${provider.name}, ${t("signIn.lastUsed")}` : provider.name}
                    data-testid={`social-button-${provider.id}`}
                    onClick={() => onSelect(provider)}
                    className={cn("relative size-10 rounded-lg", el("socialButtonsBlockButton"))}
                  >
                    {provider.logoUrl ? (
                      <img src={provider.logoUrl} alt="" className="size-5 rounded-sm object-contain" />
                    ) : (
                      <ProviderIcon provider={provider.id} className="size-5" />
                    )}
                    {lastUsed ? (
                      <span
                        aria-hidden="true"
                        data-testid={`social-last-used-${provider.id}`}
                        className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
                      />
                    ) : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className={portalClass()}>{provider.name}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", el("socialButtons"), className)} role="group" aria-label={t("common.continue")}>
      {providers.map((provider) => {
        const lastUsed = lastUsedStrategy === provider.strategy || lastUsedStrategy === provider.id;
        return (
          <Button
            key={provider.id}
            type="button"
            variant="outline"
            disabled={disabled}
            data-testid={`social-button-${provider.id}`}
            onClick={() => onSelect(provider)}
            className={cn(
              "relative w-full max-w-full min-w-0 justify-center gap-2",
              // The badge is absolutely positioned at the right edge. When any provider is the
              // last used one, reserve its width on every block button so all labels keep one
              // left edge (and the centred label never runs underneath the badge at 375px).
              // The `has-[>svg]` variant must repeat it: the base button size sets padding under
              // `:has(>svg)` for inline icons, and that variant would otherwise win by source order.
              anyLastUsed && "pr-[4.75rem] has-[>svg]:pr-[4.75rem]",
              el("socialButtonsBlockButton"),
            )}
          >
            {provider.logoUrl ? (
              <img src={provider.logoUrl} alt="" className="size-4 rounded-sm object-contain" />
            ) : (
              <ProviderIcon provider={provider.id} className="size-4" />
            )}
            <span className={cn("min-w-0 truncate", el("socialButtonsBlockButtonText"))}>
              {t("signIn.chooseStrategy.oauth", { provider: provider.name })}
            </span>
            {lastUsed ? (
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
                <span
                  className={cn(
                    "rounded-sm border border-border/70 bg-muted px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium text-muted-foreground control-optical",
                    el("badge"),
                  )}
                >
                  {t("signIn.lastUsed")}
                </span>
              </span>
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}
