import { SignUp } from "@/components/orbit-widgets";
import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";

export default function SignUpPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Sign up"
        description="The prebuilt SignUp component. Required fields, verifications and the sign-up mode come from the instance."
      />
      <ProviderGate
        title="Sign-up needs a publishable key"
        description="The SignUp component reads the instance environment through the key. Set it and restart the dev server."
      >
        <div className="flex justify-center">
          <SignUp
            routing="path"
            path="/sign-up"
            signInUrl={process.env.NEXT_PUBLIC_ORBITID_SIGN_IN_URL ?? "/sign-in"}
            fallbackRedirectUrl="/account"
            forceRedirectUrl="/account"
          />
        </div>
      </ProviderGate>
    </div>
  );
}
