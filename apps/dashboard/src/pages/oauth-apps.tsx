import { Button } from "@orbitid/ui";
import { Page as PageLayout } from "../components/shared/page";
import { Plus } from "lucide-react";
import { errorMessage } from "./_config/settings";
import { ErrorAlert, MetaChip, PageHeader, SaveBar } from "./_config/ui";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { useOAuthApps } from "./_oauth-apps/use-oauth-apps";
import { ProviderOptions } from "./_oauth-apps/provider-options";
import { ApplicationsTable } from "./_oauth-apps/applications-table";
import {
  ApplicationFormSheet,
  ApplicationDetailSheet,
  ApplicationSecretSheet,
} from "./_oauth-apps/application-sheets";

export default function Page() {
  const ctl = useOAuthApps();
  const {
    selected,
    setSelected,
    deleting,
    query,
    applications,
    config,
    settings,
    openCreate,
    oidcErrors,
    deleteApplication,
  } = ctl;

  return (
    <PageLayout>
      <PageHeader
        title="OAuth applications"
        description="OrbitID as an OAuth 2.0 and OpenID Connect identity provider. Applications use the authorize, token, userinfo, and JWKS endpoints."
        badge={<MetaChip>{applications.length} {applications.length === 1 ? "application" : "applications"}</MetaChip>}
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" aria-hidden /> Create application
          </Button>
        }
      />

      {query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}

      {config.isLoading ? (
        <p className="border-t border-border pt-4 text-[0.8125rem] text-muted-foreground">Loading provider options…</p>
      ) : null}
      {config.error ? <ErrorAlert error={config.error} onRetry={config.refetch} /> : null}

      <ProviderOptions ctl={ctl} />

      <ApplicationsTable ctl={ctl} />

      <ApplicationFormSheet ctl={ctl} />

      <ApplicationDetailSheet ctl={ctl} />

      <ApplicationSecretSheet ctl={ctl} />

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title="Delete OAuth application?"
        description={
          <span>
            <code className="font-data">{selected?.name}</code> loses access and every issued grant is invalidated.
          </span>
        }
        confirmLabel="Delete application"
        destructive
        pending={deleting}
        onConfirm={() => void deleteApplication()}
      />

      {settings ? (
        <SaveBar
          dirty={config.dirty}
          saving={config.saving}
          disabled={oidcErrors.length > 0}
          errors={oidcErrors}
          error={config.saveError}
          onSave={config.save}
          onDiscard={config.reset}
          saveLabel="Save provider options"
        />
      ) : null}
    </PageLayout>
  );
}
