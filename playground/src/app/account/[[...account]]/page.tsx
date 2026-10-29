import { UserProfile } from "@/components/orbit-widgets";
import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";

export default function AccountPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Account"
        description="Profile, email addresses, connected accounts, password, passkeys, MFA, sessions and trusted devices, using UserProfile."
      />
      <ProviderGate
        title="The account page needs a publishable key"
        description="UserProfile reads the signed-in user through the instance. Set the key and restart the dev server."
      >
        <div className="mx-auto w-full max-w-4xl space-y-4">
          <div className="space-y-1 border px-4 py-3 text-sm text-muted-foreground">
            <p>
              The Security page lists trusted devices and hides the section entirely while the feature is off. Sign in
              with a second factor and tick <span className="text-foreground">“Trust this browser”</span> to create one;
              the same browser then skips the second factor until the device expires.
            </p>
            <p>
              When the instance offers email code as a second factor it appears in the same method picker as the
              authenticator app and backup codes. A session that skipped its second factor on a trusted device is marked
              in the <span className="text-foreground">Inspector</span>.
            </p>
          </div>
          <UserProfile routing="path" path="/account" />
        </div>
      </ProviderGate>
    </div>
  );
}
