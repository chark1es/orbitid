import { useEffect, useMemo, useState } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Separator,
  Skeleton,
  cn,
} from "@orbitid/ui";
import { LockIcon, ShieldCheckIcon } from "lucide-react";
import { apiOrigin, currentUser, displayName, errorMessage, initials, primaryIdentifier, toAuthError } from "./_shared/api";
import { AuthAppearanceScope, useElementClasses } from "./_shared/appearance";
import { AuthCard } from "./_shared/auth-card";
import { FormError } from "./_shared/form-error";
import { isRecord } from "./_shared/guards";
import { useAuthRuntime, type TranslateFn } from "./_shared/w6";
import type { OAuthConsentProps } from "./_shared/types";
import type { TranslationKey } from "../../localization";

interface ConsentScope {
  scope: string;
  description: string | null;
}

interface ConsentInfo {
  application: { clientId: string; name: string; logoUrl: string | null };
  scopes: ConsentScope[];
}

const STANDARD_SCOPE_KEYS: Record<string, TranslationKey> = {
  openid: "oauthConsent.scope.openid",
  profile: "oauthConsent.scope.profile",
  email: "oauthConsent.scope.email",
  offline_access: "oauthConsent.scope.offline_access",
  phone: "oauthConsent.scope.phone",
  address: "oauthConsent.scope.address",
};

function readScopes(value: unknown): ConsentScope[] {
  if (!Array.isArray(value)) return [];
  const scopes: ConsentScope[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      scopes.push({ scope: entry, description: null });
    } else if (isRecord(entry) && typeof entry.scope === "string") {
      scopes.push({
        scope: entry.scope,
        description: typeof entry.description === "string" ? entry.description : null,
      });
    }
  }
  return scopes;
}

function normalizeConsentInfo(payload: unknown): ConsentInfo {
  if (!isRecord(payload)) return { application: { clientId: "", name: "", logoUrl: null }, scopes: [] };
  const application = isRecord(payload.application) ? payload.application : isRecord(payload.client) ? payload.client : {};
  return {
    application: {
      clientId: typeof application.client_id === "string" ? application.client_id : "",
      name: typeof application.name === "string" ? application.name : "",
      logoUrl:
        typeof application.logo_url === "string"
          ? application.logo_url
          : typeof application.image_url === "string"
            ? application.image_url
            : null,
    },
    scopes: readScopes(payload.scopes),
  };
}

async function consentRequest<T>(
  origin: string,
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  let body = rest.body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  const response = await fetch(`${origin}${path}`, { credentials: "include", ...rest, headers, body });
  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) throw toAuthError(payload);
  if (isRecord(payload) && "response" in payload) return payload.response as T;
  return payload as T;
}

function OAuthConsentInner(props: OAuthConsentProps) {
  const runtime = useAuthRuntime();
  const { orbit, environment, t, navigate } = runtime;
  const { el } = useElementClasses();
  const query = useMemo(() => {
    if (typeof window === "undefined") return new URLSearchParams();
    return new URLSearchParams(window.location.search);
  }, []);
  const clientId = props.clientId ?? query.get("client_id") ?? "";
  const scope = props.scope ?? query.get("scope") ?? "openid profile email";
  const redirectUri = props.redirectUri ?? query.get("redirect_uri") ?? "";
  const state = props.state ?? query.get("state") ?? "";
  const origin = (props.frontendApiUrl ?? apiOrigin(orbit)).replace(/\/$/, "");
  const user = currentUser(orbit);
  const extraParams = useMemo(() => {
    const entries = Object.fromEntries(query.entries());
    delete entries.client_id;
    delete entries.scope;
    delete entries.redirect_uri;
    delete entries.state;
    return entries;
  }, [query]);

  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!clientId || !redirectUri) {
      setError(t("oauthConsent.invalidRequest"));
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ ...extraParams, client_id: clientId, scope, redirect_uri: redirectUri });
    if (state) params.set("state", state);
    consentRequest<unknown>(origin, `/oauth/consent_info?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((payload) => setInfo(normalizeConsentInfo(payload)))
      .catch((caught) => {
        if ((caught as Error)?.name === "AbortError") return;
        setError(t("oauthConsent.error"));
      });
    return () => controller.abort();
  }, [origin, clientId, scope, redirectUri, state, t, extraParams]);

  const decide = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const payload = await consentRequest<unknown>(origin, "/oauth/consent", {
        method: "POST",
        json: {
          ...extraParams,
          client_id: clientId,
          scope,
          redirect_uri: redirectUri,
          state,
          // The server's field is `approve`; anything else is rejected with `form_param_missing`.
          approve: allow,
        },
      });
      const redirect =
        isRecord(payload) && typeof payload.redirect_url === "string" ? payload.redirect_url : null;
      if (redirect) {
        if (/^https?:/i.test(redirect) && typeof window !== "undefined" && !redirect.startsWith(window.location.origin)) {
          window.location.assign(redirect);
        } else {
          navigate(redirect);
        }
        return;
      }
      if (allow) props.onAllow?.(null);
      else props.onDeny?.(null);
      if (!allow && redirectUri) {
        const target = new URL(redirectUri, window.location.origin);
        target.searchParams.set("error", "access_denied");
        if (state) target.searchParams.set("state", state);
        window.location.assign(target.toString());
      }
    } catch (caught) {
      // Show what the server said (expired session, unknown application) instead of a generic failure.
      setError(errorMessage(t, caught));
    } finally {
      setBusy(false);
    }
  };

  const applicationName = info?.application.name || environment.app.name;
  const scopes = info?.scopes ?? scope.split(/\s+/).filter(Boolean).map((value) => ({ scope: value, description: null }));

  return (
    <div className="flex w-full items-center justify-center px-4 py-6">
      <AuthCard title={t("oauthConsent.title", { applicationName })} subtitle={t("oauthConsent.subtitle", { applicationName })}>
        <FormError message={error} />
        {!info && !error ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        ) : null}
        {info ? (
          <>
            <div className="flex items-center gap-3">
              <Avatar className="size-12 rounded-lg">
                {info.application.logoUrl ? <AvatarImage src={info.application.logoUrl} alt="" /> : null}
                <AvatarFallback className="rounded-lg">
                  {info.application.name.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate font-medium">{info.application.name || applicationName}</p>
                <p className="text-xs text-muted-foreground">{t("oauthConsent.subtitle", { applicationName })}</p>
              </div>
            </div>
            <Separator />
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{t("oauthConsent.scopesTitle")}</p>
              <ul className="mt-2 flex flex-col gap-2">
                {scopes.map((entry) => (
                  <li key={entry.scope} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      <span className="font-medium text-foreground">{scopeLabel(t, entry.scope)}</span>
                      {entry.description ? ` — ${entry.description}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
        {user ? (
          <div className="flex items-center gap-2 text-sm">
            <Avatar className="size-7">
              {user.image_url ? <AvatarImage src={user.image_url} alt="" /> : null}
              <AvatarFallback className="text-xs">{initials(user)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {t("oauthConsent.signedInAs", { identifier: primaryIdentifier(user) || displayName(user) })}
            </span>
          </div>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            disabled={busy || !info}
            className={cn("flex-1 gap-2", el("formButtonPrimary"))}
            onClick={() => void decide(true)}
          >
            <LockIcon className="size-4" aria-hidden="true" />
            {t("oauthConsent.allow")}
          </Button>
          <Button type="button" variant="outline" className="flex-1" disabled={busy || !info} onClick={() => void decide(false)}>
            {t("oauthConsent.deny")}
          </Button>
        </div>
      </AuthCard>
    </div>
  );
}

function scopeLabel(t: TranslateFn, scope: string): string {
  const key = STANDARD_SCOPE_KEYS[scope];
  return key ? t(key) : t("oauthConsent.scope.default", { scope });
}

export function OAuthConsent(props: OAuthConsentProps) {
  return (
    <AuthAppearanceScope appearance={props.appearance}>
      <OAuthConsentInner {...props} />
    </AuthAppearanceScope>
  );
}
