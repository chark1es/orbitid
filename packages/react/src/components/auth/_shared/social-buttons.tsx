import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn } from "@orbitid/ui";
import type { SocialProviderView } from "./environment";
import { ProviderIcon } from "./provider-icon";
import { useElementClasses } from "./appearance";
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
  const { t } = useAuthRuntime();
  const { el, appearance } = useElementClasses();
  if (providers.length === 0) return null;

  const resolvedVariant =
    variant === "auto"
      ? (appearance.layout?.socialButtonsVariant as SocialButtonsProps["variant"]) ??
        (providers.length > 3 ? "iconButton" : "blockButton")
      : variant;

  if (resolvedVariant === "iconButton") {
    return (
      <TooltipProvider delayDuration={200}>
        <div
          role="group"
          aria-label={t("common.continue")}
          className={cn("flex flex-wrap items-center justify-center gap-2", el("socialButtons"), className)}
          data-orbit-element="socialButtons"
        >
          {providers.map((provider) => (
            <Tooltip key={provider.id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={disabled}
                  aria-label={provider.name}
                  data-testid={`social-button-${provider.id}`}
                  onClick={() => onSelect(provider)}
                  className={cn("size-10 rounded-lg", el("socialButtonsBlockButton"))}
                >
                  {provider.logoUrl ? (
                    <img src={provider.logoUrl} alt="" className="size-5 rounded-sm object-contain" />
                  ) : (
                    <ProviderIcon provider={provider.id} className="size-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{provider.name}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", el("socialButtons"), className)} role="group" aria-label={t("common.continue")}>
      {providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          disabled={disabled}
          data-testid={`social-button-${provider.id}`}
          onClick={() => onSelect(provider)}
          className={cn("w-full justify-center gap-2", el("socialButtonsBlockButton"))}
        >
          {provider.logoUrl ? (
            <img src={provider.logoUrl} alt="" className="size-4 rounded-sm object-contain" />
          ) : (
            <ProviderIcon provider={provider.id} className="size-4" />
          )}
          <span className={cn("truncate", el("socialButtonsBlockButtonText"))}>
            {t("signIn.chooseStrategy.oauth", { provider: provider.name })}
          </span>
          {lastUsedStrategy === provider.strategy || lastUsedStrategy === provider.id ? (
            <span
              className={cn(
                "ms-1 rounded-full border border-border/70 bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground",
                el("badge"),
              )}
            >
              {t("signIn.lastUsed")}
            </span>
          ) : null}
        </Button>
      ))}
    </div>
  );
}
