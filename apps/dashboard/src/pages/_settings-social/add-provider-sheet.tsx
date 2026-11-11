import { useEffect, useState } from "react";
import type { SocialProviderConfig } from "@orbitid/shared";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { textToList } from "../_config/settings";
import { CheckboxRow, CopyButton, DetailSheet, Field, ValidationSummary } from "../_config/ui";
import { customKeyErrors, customKeyValue, type ProviderProtocol } from "./model";

const EMPTY = {
  name: "",
  key: "",
  protocol: "oidc" as ProviderProtocol,
  source: "discovery" as "discovery" | "manual",
  discoveryUrl: "",
  authorizationUrl: "",
  tokenUrl: "",
  userinfoUrl: "",
  jwksUrl: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid, email, profile",
  pkce: true,
  trustEmailVerified: false,
};

export function AddProviderSheet({
  open,
  onOpenChange,
  apiUrl,
  existingKeys,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiUrl: string;
  existingKeys: string[];
  onAdd: (key: string, config: SocialProviderConfig) => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const set = <K extends keyof typeof EMPTY>(field: K, value: (typeof EMPTY)[K]) => setForm((current) => ({ ...current, [field]: value }));
  const markTouched = (field: string) =>
    setTouched((current) => (current.has(field) ? current : new Set(current).add(field)));
  /** A field shows its message once it was left, or after the first Add attempt. */
  const shows = (field: string) => attempted || touched.has(field);

  useEffect(() => {
    if (!open) {
      setForm(EMPTY);
      setTouched(new Set());
      setAttempted(false);
    }
  }, [open]);

  const key = customKeyValue(form.key);
  const issues: { field: string; message: string }[] = [
    ...(form.name.trim() ? [] : [{ field: "name", message: "Display name is required." }]),
    ...customKeyErrors(form.key, existingKeys).map((message) => ({ field: "key", message })),
    ...(form.clientId.trim() ? [] : [{ field: "clientId", message: "Client ID is required." }]),
    ...(form.clientSecret.trim() || form.pkce ? [] : [{ field: "clientSecret", message: "Client secret is required when PKCE is off." }]),
  ];
  const manual = form.source === "manual";
  if (manual) {
    if (!form.authorizationUrl.trim()) issues.push({ field: "authorizationUrl", message: "Authorization URL is required." });
    else if (!/^https?:\/\//i.test(form.authorizationUrl.trim())) issues.push({ field: "authorizationUrl", message: "Authorization URL must be an http(s) URL." });
    if (!form.tokenUrl.trim()) issues.push({ field: "tokenUrl", message: "Token URL is required." });
    else if (!/^https?:\/\//i.test(form.tokenUrl.trim())) issues.push({ field: "tokenUrl", message: "Token URL must be an http(s) URL." });
    if (form.protocol === "oauth2") {
      if (!form.userinfoUrl.trim()) issues.push({ field: "userinfoUrl", message: "OAuth 2.0 needs a userinfo URL." });
      else if (!/^https?:\/\//i.test(form.userinfoUrl.trim())) issues.push({ field: "userinfoUrl", message: "Userinfo URL must be an http(s) URL." });
    }
  } else if (!form.discoveryUrl.trim()) {
    issues.push({ field: "discoveryUrl", message: "Discovery URL is required." });
  } else if (!/^https?:\/\//i.test(form.discoveryUrl.trim())) {
    issues.push({ field: "discoveryUrl", message: "Discovery URL must be an http(s) URL." });
  }
  const errors = issues.filter((issue) => shows(issue.field)).map((issue) => issue.message);

  const add = () => {
    setAttempted(true);
    if (issues.length > 0) return;
    const config: SocialProviderConfig = {
      enabled: true,
      name: form.name.trim(),
      clientId: form.clientId.trim(),
      clientSecret: form.clientSecret,
      scopes: textToList(form.scopes),
      authenticatableAtSignIn: true,
      protocol: form.protocol,
      clientAuthMethod: "client_secret_basic",
      pkce: form.pkce,
      trustEmailVerified: form.trustEmailVerified,
      claimMapping: { sub: "", email: "", emailVerified: "", name: "", firstName: "", lastName: "", username: "", picture: "" },
      ...(manual
        ? {
            authorizationUrl: form.authorizationUrl.trim(),
            tokenUrl: form.tokenUrl.trim(),
            userinfoUrl: form.userinfoUrl.trim() || undefined,
            jwksUrl: form.jwksUrl.trim() || undefined,
            issuer: form.issuer.trim() || undefined,
            discoveryUrl: "",
          }
        : { discoveryUrl: form.discoveryUrl.trim(), scopes: textToList(form.scopes || (form.protocol === "oauth2" ? "" : "openid, email, profile")) }),
    };
    onAdd(`custom_${key}`, config);
    setForm(EMPTY);
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add custom provider"
      description="Connect any OpenID Connect or OAuth 2.0 provider. Use a discovery document when it publishes one."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={add}>
            Add provider
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name" htmlFor="custom-name" required>
            <Input id="custom-name" value={form.name} onChange={(event) => set("name", event.target.value)} onBlur={() => markTouched("name")} placeholder="Acme ID" />
          </Field>
          <Field label="Provider key" htmlFor="custom-key" required description="Stored as custom_<key>; it appears in strategies and in the callback URL.">
            <Input id="custom-key" value={form.key} onChange={(event) => set("key", event.target.value)} onBlur={() => markTouched("key")} placeholder="acme" className="font-data text-xs" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Protocol" htmlFor="custom-protocol">
            <Select value={form.protocol} onValueChange={(value) => set("protocol", value as ProviderProtocol)}>
              <SelectTrigger id="custom-protocol" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="oidc">OpenID Connect</SelectItem>
                <SelectItem value="oauth2">OAuth 2.0</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Endpoints" htmlFor="custom-source">
            <Select value={form.source} onValueChange={(value) => set("source", value as "discovery" | "manual")}>
              <SelectTrigger id="custom-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="discovery">Discovery document</SelectItem>
                <SelectItem value="manual">Manual endpoints</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {manual ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Authorization URL" htmlFor="custom-auth-url" required>
              <Input id="custom-auth-url" value={form.authorizationUrl} onChange={(event) => set("authorizationUrl", event.target.value)} onBlur={() => markTouched("authorizationUrl")} placeholder="https://provider.example/oauth/authorize" className="font-data text-xs" />
            </Field>
            <Field label="Token URL" htmlFor="custom-token-url" required>
              <Input id="custom-token-url" value={form.tokenUrl} onChange={(event) => set("tokenUrl", event.target.value)} onBlur={() => markTouched("tokenUrl")} placeholder="https://provider.example/oauth/token" className="font-data text-xs" />
            </Field>
            <Field label="Userinfo URL" htmlFor="custom-userinfo-url" required={form.protocol === "oauth2"}>
              <Input id="custom-userinfo-url" value={form.userinfoUrl} onChange={(event) => set("userinfoUrl", event.target.value)} onBlur={() => markTouched("userinfoUrl")} placeholder="https://provider.example/oauth/userinfo" className="font-data text-xs" />
            </Field>
            <Field label="JWKS URL" htmlFor="custom-jwks-url" description="Optional, for a signed ID token.">
              <Input id="custom-jwks-url" value={form.jwksUrl} onChange={(event) => set("jwksUrl", event.target.value)} placeholder="https://provider.example/.well-known/jwks.json" className="font-data text-xs" />
            </Field>
            <Field label="Issuer" htmlFor="custom-issuer" description="Expected `iss` claim.">
              <Input id="custom-issuer" value={form.issuer} onChange={(event) => set("issuer", event.target.value)} placeholder="https://provider.example" className="font-data text-xs" />
            </Field>
          </div>
        ) : (
          <Field label="Discovery URL" htmlFor="custom-discovery" required>
            <Input id="custom-discovery" value={form.discoveryUrl} onChange={(event) => set("discoveryUrl", event.target.value)} onBlur={() => markTouched("discoveryUrl")} placeholder="https://auth.acme.com/.well-known/openid-configuration" className="font-data text-xs" />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client ID" htmlFor="custom-client-id" required>
            <Input id="custom-client-id" value={form.clientId} onChange={(event) => set("clientId", event.target.value)} onBlur={() => markTouched("clientId")} className="font-data text-xs" />
          </Field>
          <Field label="Client secret" htmlFor="custom-client-secret" description="Optional for a public client that uses PKCE.">
            <Input id="custom-client-secret" type="password" autoComplete="new-password" value={form.clientSecret} onChange={(event) => set("clientSecret", event.target.value)} onBlur={() => markTouched("clientSecret")} />
          </Field>
        </div>
        <Field label="Scopes" htmlFor="custom-scopes">
          <Input id="custom-scopes" value={form.scopes} onChange={(event) => set("scopes", event.target.value)} className="font-data text-xs" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <CheckboxRow label="Use PKCE (S256)" description="Recommended for every provider." checked={form.pkce} onCheckedChange={(pkce) => set("pkce", pkce)} />
          <CheckboxRow label="Trust email as verified" description="Only when the provider checks addresses but sends no email_verified claim." checked={form.trustEmailVerified} onCheckedChange={(trustEmailVerified) => set("trustEmailVerified", trustEmailVerified)} />
        </div>
        {key ? (
          <div className="flex items-center justify-between gap-4 border-y border-border py-2">
            <div className="min-w-0">
              <p className="text-[0.8125rem] font-medium">Callback URL</p>
              <code className="block truncate font-data text-xs text-muted-foreground">{`${apiUrl.replace(/\/+$/, "")}/v1/oauth_callback/custom_${key}`}</code>
            </div>
            <CopyButton value={`${apiUrl.replace(/\/+$/, "")}/v1/oauth_callback/custom_${key}`} size="sm" variant="outline" label="Copy" />
          </div>
        ) : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          After adding, open the provider to test the endpoints, map claims and edit the scopes.
        </p>
        <ValidationSummary errors={errors} title="Fill the required fields" />
      </div>
    </DetailSheet>
  );
}
