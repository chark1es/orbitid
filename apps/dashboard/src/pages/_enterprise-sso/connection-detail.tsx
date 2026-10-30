import { Button, Input } from "@orbitid/ui";
import { Download, Trash2 } from "lucide-react";
import { CopyButton, DetailSheet, EndpointRow, Field, SwitchRow } from "../_config/ui";
import type { EnterpriseSsoController } from "./use-enterprise-sso";
import { samlSpDetails } from "./model";

export function ConnectionDetail({ ctl }: { ctl: EnterpriseSsoController }) {
  const {
    detail,
    setDetail,
    setSelected,
    updatingAdvanced,
    replacementSecret,
    setReplacementSecret,
    apiBase,
    toggleActive,
    updateAdvanced,
    replaceOidcSecret,
    downloadMetadata,
  } = ctl;

  return (
    <DetailSheet
      open={detail !== null}
      onOpenChange={(open) => !open && setDetail(null)}
      size="lg"
      title={detail?.name ?? "Connection"}
      description={detail ? `${detail.protocol.toUpperCase()} connection` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={() => setDetail(null)}>
            Close
          </Button>
          {detail ? (
            <Button variant="destructive" onClick={() => setSelected(detail)}>
              <Trash2 className="size-4" aria-hidden /> Delete
            </Button>
          ) : null}
        </>
      }
    >
      {detail ? (
        <div className="space-y-5">
          <SwitchRow
            label="Active"
            description="Route sign-ins for these domains to this identity provider."
            checked={detail.active}
            onCheckedChange={() => void toggleActive(detail)}
          />
          <div className="flex flex-wrap gap-1">
            {detail.domains.map((domain) => (
              <span key={domain} className="border border-border px-1.5 py-0.5 font-data text-xs text-muted-foreground">
                {domain}
              </span>
            ))}
          </div>
          {detail.protocol === "saml" ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Service provider details</p>
              <p className="text-xs leading-relaxed text-muted-foreground">Use these values in the SAML application at your IdP.</p>
              <EndpointRow label="ACS URL" url={samlSpDetails(detail, apiBase).acsUrl} />
              <EndpointRow label="SP entity ID" url={samlSpDetails(detail, apiBase).entityId} />
              <EndpointRow label="Metadata URL" url={samlSpDetails(detail, apiBase).metadataUrl} />
              <Button variant="outline" size="sm" onClick={() => void downloadMetadata(detail)}>
                <Download className="size-4" aria-hidden /> Download metadata XML
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">OpenID Connect</p>
              <EndpointRow label="Discovery URL" url={detail.oidc?.discovery_url ?? "Not set"} />
              {detail.oidc?.client_id ? (
                <div className="flex items-center justify-between gap-3 border-b border-border py-2">
                  <div className="min-w-0">
                    <p className="text-[0.8125rem] font-medium">Client ID</p>
                    <code className="block truncate font-data text-xs text-muted-foreground">{detail.oidc.client_id}</code>
                  </div>
                  <CopyButton value={detail.oidc.client_id} size="icon-sm" variant="outline" />
                </div>
              ) : null}
              <Field
                label="Replace client secret"
                htmlFor="sso-oidc-replace-secret"
                description="The stored secret is never returned by the API. Leave blank to keep it; type a new value to replace it."
              >
                <Input
                  id="sso-oidc-replace-secret"
                  type="password"
                  autoComplete="new-password"
                  value={replacementSecret}
                  onChange={(event) => setReplacementSecret(event.target.value)}
                  placeholder="Leave blank to keep the stored secret"
                />
              </Field>
              <Button
                variant="outline"
                size="sm"
                disabled={!replacementSecret.trim() || updatingAdvanced}
                onClick={() => void replaceOidcSecret()}
              >
                Replace secret
              </Button>
            </div>
          )}
          <div>
            <p className="pb-1 text-sm font-medium">Advanced</p>
            <SwitchRow
              label="Allow subdomains"
              checked={detail.allow_subdomains}
              disabled={updatingAdvanced}
              onCheckedChange={(allow_subdomains) => void updateAdvanced({ allow_subdomains })}
            />
            <SwitchRow
              label="Allow IdP-initiated sign-in"
              checked={detail.allow_idp_initiated}
              disabled={updatingAdvanced}
              onCheckedChange={(allow_idp_initiated) => void updateAdvanced({ allow_idp_initiated })}
            />
            <SwitchRow
              label="Sync user attributes"
              checked={detail.sync_user_attributes}
              disabled={updatingAdvanced}
              onCheckedChange={(sync_user_attributes) => void updateAdvanced({ sync_user_attributes })}
            />
            <SwitchRow
              label="Disable additional identifications"
              description="Prevent users from adding email addresses outside this IdP's domains."
              checked={detail.disable_additional_identifications}
              disabled={updatingAdvanced}
              onCheckedChange={(disable_additional_identifications) => void updateAdvanced({ disable_additional_identifications })}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Sign-ins with an email at {detail.domains.join(", ")} return the enterprise SSO factor. Deactivating the connection falls back
            to the other sign-in methods.
          </p>
        </div>
      ) : null}
    </DetailSheet>
  );
}
