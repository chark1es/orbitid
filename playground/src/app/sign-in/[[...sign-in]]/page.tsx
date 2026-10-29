import { SignIn } from "@/components/orbit-widgets";
import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";

export default function SignInPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Sign in"
        description="The prebuilt SignIn component, rendered from this instance's environment. Path routing keeps the current step in the URL."
      />
      <ProviderGate
        title="Sign-in needs a publishable key"
        description="The SignIn component reads the instance environment through the key. Set it and restart the dev server."
      >
        <div className="flex justify-center">
          <SignIn
            routing="path"
            path="/sign-in"
            signUpUrl={process.env.NEXT_PUBLIC_ORBITID_SIGN_UP_URL ?? "/sign-up"}
            fallbackRedirectUrl="/account"
          />
        </div>
      </ProviderGate>
    </div>
  );
}
