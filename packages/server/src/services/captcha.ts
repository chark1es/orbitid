// Server-side CAPTCHA verification (Cloudflare Turnstile / hCaptcha).
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import { safeFetch } from "../lib/safe-fetch";

/** Test seam: lets tests stub the verification result without network calls. */
let verifierOverride: ((token: string, remoteIp?: string) => Promise<boolean>) | null = null;

export function setCaptchaVerifierForTests(fn: ((token: string, remoteIp?: string) => Promise<boolean>) | null) {
  verifierOverride = fn;
}

/**
 * Verifies the CAPTCHA token supplied as body `captcha_token` or header `X-Captcha-Token`.
 * No-op when no provider is configured (or the provider has no secret yet).
 */
export async function verifyCaptcha(ctx: AppContext, token: string | undefined, remoteIp?: string): Promise<void> {
  const sec = ctx.settings.get().security;
  if (sec.captchaProvider === "none" || !sec.captchaSecret) return;
  if (verifierOverride) {
    if (!(await verifierOverride(token ?? "", remoteIp))) throw botDetected();
    return;
  }
  if (!token) throw botDetected();
  const endpoint = sec.captchaProvider === "turnstile"
    ? "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    : "https://api.hcaptcha.com/siteverify";
  const body = new URLSearchParams({ secret: sec.captchaSecret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await safeFetch(ctx, endpoint, { method: "POST", body, timeoutMs: 5_000, maxBytes: 64 * 1024 });
    const json = res.json<{ success?: boolean }>();
    if (!json.success) throw botDetected();
  } catch (err) {
    if (err instanceof OrbitError) throw err;
    // Provider unreachable: fail closed only when a secret is configured (bot protection is an explicit opt-in).
    throw botDetected();
  }
}

const botDetected = () =>
  new OrbitError(400, ErrorCodes.bot_detected, "Bot traffic detected. Please try again.", { param_name: "captcha_token" });
