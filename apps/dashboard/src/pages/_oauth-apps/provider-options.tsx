import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { EndpointRow, Field, MetaChip, SettingsSection, SwitchRow, ValidationSummary } from "../_config/ui";
import type { OAuthAppsController } from "./use-oauth-apps";
import { numberFrom } from "./model";

export function ProviderOptions({ ctl }: { ctl: OAuthAppsController }) {
  const { issuer, config, settings, oidcErrors } = ctl;

  return (
    <>
      {settings ? (
        <SettingsSection
          title="Provider options"
          description="Instance-wide behaviour for every application registered below."
          actions={<MetaChip>{settings.oidcProvider.accessTokenFormat === "jwt" ? "JWT access tokens" : "Opaque access tokens"}</MetaChip>}
        >
          <Field
            label="Access token format"
            htmlFor="oidc-token-format"
            description={
              settings.oidcProvider.accessTokenFormat === "jwt"
                ? "Access tokens are RS256 JWTs signed with the instance key, so resource servers verify them offline against the JWKS. Revocation still applies."
                : "Access tokens are opaque strings. Every resource server calls the userinfo or introspection endpoint to check them."
            }
            className="max-w-lg"
          >
            <Select
              value={settings.oidcProvider.accessTokenFormat}
              onValueChange={(accessTokenFormat) =>
                config.patch({ oidcProvider: { accessTokenFormat: accessTokenFormat as "opaque" | "jwt" } })
              }
            >
              <SelectTrigger id="oidc-token-format" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="opaque">Opaque (server lookup)</SelectItem>
                <SelectItem value="jwt">JWT (verify offline)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <SwitchRow
            label="Allow the device authorization grant"
            description="Let CLIs and TVs sign in by showing a short code. Endpoints return 404 while this is off."
            checked={settings.oidcProvider.deviceAuthorizationEnabled}
            onCheckedChange={(deviceAuthorizationEnabled) => config.patch({ oidcProvider: { deviceAuthorizationEnabled } })}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Refresh retry grace (seconds)"
              htmlFor="oidc-refresh-grace"
              description="A just-rotated refresh token may be retried for this long. 0 disables the grace."
            >
              <Input
                id="oidc-refresh-grace"
                type="number"
                min={0}
                max={600}
                value={settings.oidcProvider.refreshTokenReuseGraceSeconds}
                onChange={(event) =>
                  config.patch({ oidcProvider: { refreshTokenReuseGraceSeconds: numberFrom(event.target.value) } })
                }
              />
            </Field>
            <Field
              label="Device code lifetime (seconds)"
              htmlFor="oidc-device-lifetime"
              description="How long the user has to enter the code."
            >
              <Input
                id="oidc-device-lifetime"
                type="number"
                min={60}
                value={settings.oidcProvider.deviceCodeLifetimeSeconds}
                disabled={!settings.oidcProvider.deviceAuthorizationEnabled}
                onChange={(event) =>
                  config.patch({ oidcProvider: { deviceCodeLifetimeSeconds: numberFrom(event.target.value) } })
                }
              />
            </Field>
            <Field
              label="Minimum polling interval (seconds)"
              htmlFor="oidc-device-interval"
              description="Faster polls are answered with slow_down."
            >
              <Input
                id="oidc-device-interval"
                type="number"
                min={1}
                value={settings.oidcProvider.deviceCodeIntervalSeconds}
                disabled={!settings.oidcProvider.deviceAuthorizationEnabled}
                onChange={(event) =>
                  config.patch({ oidcProvider: { deviceCodeIntervalSeconds: numberFrom(event.target.value) } })
                }
              />
            </Field>
          </div>

          {settings.oidcProvider.deviceAuthorizationEnabled ? (
            <div>
              <p className="pb-1 text-sm font-medium">Device flow endpoints</p>
              <EndpointRow label="Device authorization" url={`${issuer}/oauth/device_authorization`} />
              <EndpointRow label="Verification page" url={`${issuer}/oauth/device`} />
            </div>
          ) : null}
          {oidcErrors.length > 0 ? <ValidationSummary errors={oidcErrors} title="Fix the provider options" /> : null}
        </SettingsSection>
      ) : null}
    </>
  );
}
