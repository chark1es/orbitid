import {
  CreateOrganization,
  OrganizationList,
  OrganizationProfile,
  OrganizationSwitcher,
} from "@/components/orbit-widgets";
import { PageHeader } from "@/components/page-header";
import { OrganizationsGate } from "@/components/organizations-gate";
import { ProviderGate } from "@/components/provider-gate";

export default function OrganizationsPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Organizations"
        description="Memberships, switching, the active organization profile and organization creation, all from the instance's organization settings."
        actions={<OrganizationSwitcher hidePersonal={false} />}
      />
      <ProviderGate
        title="Organizations need a publishable key"
        description="The organization components read the active session and the instance settings through the key."
      >
        <OrganizationsGate>
          <div className="space-y-10">
            <section aria-labelledby="org-list-title" className="space-y-3">
              <div>
                <h2 id="org-list-title" className="text-lg">
                  Memberships
                </h2>
                <p className="text-muted-foreground">Pick an active organization, or keep the personal account.</p>
              </div>
              <div className="max-w-2xl">
                <OrganizationList afterSelectOrganizationUrl="/organizations" afterCreateOrganizationUrl="/organizations" />
              </div>
            </section>

            <section aria-labelledby="org-profile-title" className="space-y-3">
              <div>
                <h2 id="org-profile-title" className="text-lg">
                  Active organization
                </h2>
                <p className="text-muted-foreground">General settings, members, invitations and domains for the selected organization.</p>
              </div>
              <OrganizationProfile afterLeaveOrganizationUrl="/organizations" />
            </section>

            <section aria-label="Create an organization" className="max-w-2xl">
              <CreateOrganization skipInvitationScreen afterCreateOrganizationUrl="/organizations" />
            </section>
          </div>
        </OrganizationsGate>
      </ProviderGate>
    </div>
  );
}
