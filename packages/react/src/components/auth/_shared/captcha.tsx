import { useEffect, useRef, useState } from "react";
import { cn } from "@orbitid/ui";
import { useElementClasses, useResolvedTheme } from "./appearance";
import { useAuthRuntime } from "./w6";

interface CaptchaWidgetApi {
  render(container: HTMLElement, options: Record<string, unknown>): string | number;
  remove(widgetId: string | number): void;
}

interface CaptchaWindow extends Window {
  turnstile?: CaptchaWidgetApi;
  hcaptcha?: CaptchaWidgetApi;
}

const SCRIPT_URLS: Record<string, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  hcaptcha: "https://js.hcaptcha.com/1/api.js?render=explicit",
};

function loadScript(provider: string, src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-orbit-captcha="${provider}"]`);
  if (existing) {
    return existing.dataset.loaded === "true"
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener("error", () => reject(new Error("captcha_script_failed")), { once: true });
        });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.dataset.orbitCaptcha = provider;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    });
    script.addEventListener("error", () => reject(new Error("captcha_script_failed")));
    document.head.appendChild(script);
  });
}

export interface CaptchaWidgetProps {
  siteKey?: string;
  provider?: "turnstile" | "hcaptcha" | string;
  onToken: (token: string | null) => void;
  theme?: "light" | "dark" | "auto";
  className?: string;
}

/**
 * Cloudflare Turnstile / hCaptcha slot. The script is loaded only when the environment enables
 * captcha and a site key is configured; the token is handed back for `captcha_token`.
 */
export function CaptchaWidget({ siteKey, provider, onToken, theme: themeProp, className }: CaptchaWidgetProps) {
  const runtime = useAuthRuntime();
  const { ep } = useElementClasses();
  // Match the card around it rather than the operating system ("auto"), which differs when the page picked a scheme.
  const resolvedTheme = useResolvedTheme();
  const theme = themeProp ?? resolvedTheme;
  const container = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const resolvedProvider = provider && provider !== "none" ? provider : runtime.environment.captcha.provider;
  const resolvedSiteKey = siteKey ?? runtime.environment.captcha.siteKey;
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!resolvedSiteKey || resolvedProvider === "none") return;
    const src = SCRIPT_URLS[resolvedProvider];
    if (!src) return;
    let widgetId: string | number | null = null;
    let cancelled = false;

    loadScript(resolvedProvider, src)
      .then(() => {
        if (cancelled || !container.current) return;
        const api = (window as CaptchaWindow)[resolvedProvider as "turnstile" | "hcaptcha"];
        if (!api) return;
        widgetId = api.render(container.current, {
          sitekey: resolvedSiteKey,
          theme,
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => {
            onTokenRef.current(null);
            setFailed(true);
          },
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      const api = (window as CaptchaWindow)[resolvedProvider as "turnstile" | "hcaptcha"];
      if (api && widgetId !== null) {
        try {
          api.remove(widgetId);
        } catch {
          // Widget already unmounted.
        }
      }
    };
  }, [resolvedProvider, resolvedSiteKey, theme]);

  if (!resolvedSiteKey || resolvedProvider === "none") return null;
  if (failed) {
    return (
      <p role="alert" className={cn("text-xs text-destructive", className)} data-orbit-element="captcha">
        Captcha could not be loaded. Reload the page.
      </p>
    );
  }
  return (
    <div
      ref={container}
      data-orbit-element="captcha"
      data-testid="captcha-widget"
      {...ep("captcha", "flex min-h-[65px] w-full justify-center", className)}
    />
  );
}
