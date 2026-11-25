import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn } from "@orbitid/ui";
import type { SocialProviderView } from "./environment";
import { ProviderIcon } from "./provider-icon";
import { useComponentElements, usePortalClass } from "./appearance";
import { useAuthRuntime } from "./w6";
import { LastUsedBadge } from "./last-used-badge";

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
  const { ep, appearance } = useComponentElements();
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
          {...ep("socialButtons", "grid grid-cols-[repeat(auto-fit,minmax(3rem,1fr))] gap-2", className)}
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
                    {...ep("socialButtonsIconButton", "relative h-9 w-full shadow-xs")}
                  >
                    {provider.logoUrl ? (
                      <img src={provider.logoUrl} alt="" {...ep("socialButtonsProviderIcon", "size-4 shrink-0 rounded-sm object-contain")} />
                    ) : (
                      <ProviderIcon provider={provider.id} {...ep("socialButtonsProviderIcon", "size-4")} />
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
    <div {...ep("socialButtons", "flex flex-col gap-2", className)} role="group" aria-label={t("common.continue")}>
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
            // The badge is absolutely positioned at the right edge. When any provider is the last used one, reserve
            // its width on every block button so all labels keep one left edge (and the centred label never runs
            // underneath the badge at 375px). The `has-[>svg]` variant must repeat it: the base button size sets
            // padding under `:has(>svg)` for inline icons, and that variant would otherwise win by source order.
            {...ep(
              "socialButtonsBlockButton",
              "relative h-9 w-full max-w-full min-w-0 justify-center gap-2.5 shadow-xs",
              anyLastUsed && "pr-[4.75rem] has-[>svg]:pr-[4.75rem]",
            )}
          >
            {provider.logoUrl ? (
              <img src={provider.logoUrl} alt="" {...ep("socialButtonsProviderIcon", "size-4 shrink-0 rounded-sm object-contain")} />
            ) : (
              <ProviderIcon provider={provider.id} {...ep("socialButtonsProviderIcon", "size-4")} />
            )}
            <span {...ep("socialButtonsBlockButtonText", "min-w-0 truncate")}>
              {t("signIn.chooseStrategy.oauth", { provider: provider.name })}
            </span>
            {lastUsed ? (
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
                <LastUsedBadge />
              </span>
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}
