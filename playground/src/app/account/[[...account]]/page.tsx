import { UserProfile } from "@/components/orbit-widgets";
import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";

export default function AccountPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Account"
        description="Profile, email addresses, connected accounts, password, passkeys, MFA and active sessions, using UserProfile."
      />
      <ProviderGate
        title="The account page needs a publishable key"
        description="UserProfile reads the signed-in user through the instance. Set the key and restart the dev server."
      >
        <div className="mx-auto w-full max-w-4xl">
          <UserProfile routing="path" path="/account" />
        </div>
      </ProviderGate>
    </div>
  );
}
