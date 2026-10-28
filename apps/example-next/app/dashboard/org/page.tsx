import { CreateOrganization, OrganizationProfile } from "@/components/orbit-widgets";

export default function OrganizationPage() {
  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">Organization</h1>
        <p className="text-sm text-muted-foreground">
          General settings, members, invitations, domains and membership requests.
        </p>
        <OrganizationProfile />
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Create another organization</h2>
        <CreateOrganization afterCreateOrganizationUrl="/dashboard/org" />
      </section>
    </div>
  );
}
