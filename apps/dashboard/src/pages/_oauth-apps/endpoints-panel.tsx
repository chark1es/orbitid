import type { OAuthApplicationJSON } from "@orbitid/shared";
import { CopyButton, EndpointRow, Notice } from "../_config/ui";
import type { OidcDiscovery } from "./use-oauth-apps";

function Snippet({ title, value }: { title: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{title}</p>
        <CopyButton value={value} size="icon-sm" variant="outline" />
      </div>
      <pre className="overflow-x-auto border border-border bg-muted/40 p-2 font-data text-[0.6875rem] leading-relaxed">
        <code>{value}</code>
      </pre>
    </div>
  );
}

export function EndpointsPanel({ issuer, discovery }: { issuer: string; discovery: OidcDiscovery | null }) {
  const endpoint = (key: keyof OidcDiscovery, fallback: string) =>
    (typeof discovery?.[key] === "string" ? (discovery[key] as string) : `${issuer}${fallback}`);
  return (
    <div>
      <p className="pb-1 text-sm font-medium">Endpoints</p>
      <EndpointRow label="Issuer" url={issuer} description="The exact iss value in every token. Must match in the client." />
      <EndpointRow label="Discovery document" url={`${issuer}/.well-known/openid-configuration`} />
      <EndpointRow label="Authorization endpoint" url={endpoint("authorization_endpoint", "/oauth/authorize")} />
      <EndpointRow label="Token endpoint" url={endpoint("token_endpoint", "/oauth/token")} />
      <EndpointRow label="UserInfo endpoint" url={endpoint("userinfo_endpoint", "/oauth/userinfo")} />
      <EndpointRow label="JWKS" url={endpoint("jwks_uri", "/oauth/jwks")} />
      <EndpointRow label="Revocation endpoint" url={endpoint("revocation_endpoint", "/oauth/revoke")} />
      <EndpointRow label="Introspection endpoint" url={endpoint("introspection_endpoint", "/oauth/introspect")} />
      <EndpointRow label="End session (logout)" url={endpoint("end_session_endpoint", "/oauth/end_session")} />
      {discovery?.device_authorization_endpoint ? (
        <EndpointRow label="Device authorization endpoint" url={discovery.device_authorization_endpoint} />
      ) : null}
    </div>
  );
}

export function IntegrationSnippets({
  issuer,
  detail,
  discovery,
}: {
  issuer: string;
  detail: OAuthApplicationJSON;
  discovery: OidcDiscovery | null;
}) {
  const endpoint = (key: keyof OidcDiscovery, fallback: string) =>
    (typeof discovery?.[key] === "string" ? (discovery[key] as string) : `${issuer}${fallback}`);
  const clientId = detail.client_id;
  const secret = "PASTE_CLIENT_SECRET";
  const tinyauth = [
    `TINYAUTH_OAUTH_PROVIDERS_ORBITID_CLIENTID=${clientId}`,
    `TINYAUTH_OAUTH_PROVIDERS_ORBITID_CLIENTSECRET=${secret}`,
    `TINYAUTH_OAUTH_PROVIDERS_ORBITID_AUTHURL=${endpoint("authorization_endpoint", "/oauth/authorize")}`,
    `TINYAUTH_OAUTH_PROVIDERS_ORBITID_TOKENURL=${endpoint("token_endpoint", "/oauth/token")}`,
    `TINYAUTH_OAUTH_PROVIDERS_ORBITID_USERINFOURL=${endpoint("userinfo_endpoint", "/oauth/userinfo")}`,
    `TINYAUTH_OAUTH_PROVIDERS_ORBITID_SCOPES=openid email profile groups`,
    `TINYAUTH_OAUTH_PROVIDERS_ORBITID_NAME=OrbitID`,
  ].join("\n");
  const oauth2Proxy = [
    `--provider=oidc`,
    `--oidc-issuer-url=${issuer}`,
    `--client-id=${clientId}`,
    `--client-secret=${secret}`,
    `--redirect-url=https://app.example.com/oauth2/callback`,
    `--scope="openid profile email groups"`,
  ].join(" \\\n  ");
  const authentikFields = [
    `Provider type: OpenID Connect`,
    `Consumer key (client ID): ${clientId}`,
    `Consumer secret: ${secret}`,
    `Authorization URL: ${endpoint("authorization_endpoint", "/oauth/authorize")}`,
    `Token URL: ${endpoint("token_endpoint", "/oauth/token")}`,
    `Userinfo URL: ${endpoint("userinfo_endpoint", "/oauth/userinfo")}`,
    `Scopes: openid email profile groups`,
    `Subject key: sub`,
    `Username key: preferred_username`,
    `Email key: email`,
    `Name key: name`,
    `Group key: groups`,
    `Redirect URI: https://<authentik-host>/source/oauth/callback/<source-slug>/`,
  ].join("\n");

  return (
    <div className="space-y-4">
      <div>
        <p className="pb-1 text-sm font-medium">Copy-ready configuration</p>
        <p className="text-xs text-muted-foreground">
          These use this application's endpoints and client ID. Copy the secret from the creation dialog first.
        </p>
      </div>
      <Snippet title="Tinyauth (OAuth provider, static endpoints)" value={tinyauth} />
      <Snippet title="Authentik (OAuth source / OpenID Connect source)" value={authentikFields} />
      <Snippet title="oauth2-proxy (generic OIDC)" value={oauth2Proxy} />
      <Notice title="No PKCE? Leave it off for these clients">
        <p>
          Tinyauth, Authentik sources and oauth2-proxy do not send a PKCE challenge. Keep <strong>Require PKCE</strong>{" "}
          off for a confidential client; public clients always require PKCE.
        </p>
      </Notice>
    </div>
  );
}
