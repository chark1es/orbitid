import { Waitlist } from "@/components/orbit-widgets";
import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";

export default function WaitlistPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Waitlist"
        description="Join the waitlist exactly as a visitor would. The instance decides whether the form accepts an address."
      />
      <ProviderGate
        title="The waitlist needs a publishable key"
        description="The Waitlist component posts to the instance Frontend API through the publishable key."
      >
        <div className="flex justify-center">
          <Waitlist signInUrl="/sign-in" />
        </div>
      </ProviderGate>
    </div>
  );
}
