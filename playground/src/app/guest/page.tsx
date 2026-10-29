import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";
import { GuestDemo } from "@/components/guest-demo";
import { EMAIL_TRANSPORT_LABELS, resolveEmailTransport } from "@/lib/email";
import { loadInstanceSnapshot } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function GuestPage() {
  const instance = await loadInstanceSnapshot();
  const transport = instance?.email
    ? EMAIL_TRANSPORT_LABELS[resolveEmailTransport(instance.email).provider]
    : null;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Guest accounts"
        description="Create an anonymous session with the browser SDK, watch the anonymous claim in the token, and upgrade the same account in place."
      />
      <ProviderGate
        title="The guest page needs a publishable key"
        description="signUp.createAnonymous() and useUser() talk to the instance Frontend API through the publishable key."
      >
        <div className="mb-6 max-w-[75ch] space-y-1 border px-4 py-3 text-sm text-muted-foreground">
          <p>
            A guest has no email address, phone number, password or connected account. It gets an active session
            immediately and an <code className="font-data">anonymous: true</code> claim in every token.
          </p>
          <p>
            Guests cannot create organizations or API keys. The account becomes registered the moment it verifies an
            identifier, sets a password or connects an account.
          </p>
        </div>
        <GuestDemo emailTransport={transport} />
      </ProviderGate>
    </div>
  );
}
