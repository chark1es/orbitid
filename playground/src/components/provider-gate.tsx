import { SetupRequired } from "./setup-required";
import { decodeKey, readPublishableKey } from "@/lib/env";

/** Server guard for pages that need the browser SDK. Rendering hooks without a key throws. */
export function ProviderGate({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  if (!readPublishableKey()) {
    return <SetupRequired title={title} description={description} missing="NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not set" />;
  }
  if (!decodeKey()) {
    return (
      <SetupRequired
        title={title}
        description={description}
        missing="NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not a valid pk_test or pk_live key"
      />
    );
  }
  return <>{children}</>;
}
