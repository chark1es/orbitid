import { PageHeader } from "@/components/page-header";
import { SetupRequired } from "@/components/setup-required";
import { DeviceDemo } from "@/components/device-demo";
import { getDeviceFlow, deviceFlowView, orderApplicationsForDeviceFlow } from "@/lib/device-flow";
import { readSecretKey, resolveApiUrl } from "@/lib/env";
import { listDeviceApplications } from "./actions";

export const dynamic = "force-dynamic";

export default async function DevicePage() {
  const secretKeyPresent = Boolean(readSecretKey());
  const listed = secretKeyPresent
    ? await listDeviceApplications()
    : { ok: false, applications: [], error: "ORBITID_SECRET_KEY is not set." };
  const applications = orderApplicationsForDeviceFlow(listed.applications);
  const flow = deviceFlowView(getDeviceFlow());

  return (
    <div className="space-y-8">
      <PageHeader
        title="Device flow"
        description="RFC 8628: a CLI or TV shows a short code, the person approves it in the browser, and the device polls the token endpoint until it gets a token set."
      />

      {!secretKeyPresent ? (
        <SetupRequired
          title="The device flow needs the secret key"
          description="The grant needs an OAuth application, and applications are managed with the Backend API. Without the key the page still explains the endpoints but cannot start a request."
          missing="ORBITID_SECRET_KEY is not set"
        />
      ) : null}

      <div className="max-w-[75ch] space-y-1 border px-4 py-3 text-sm text-muted-foreground">
        <p>
          The grant is off by default. Turn it on in the dashboard under OAuth apps, then register a public
          application here — public clients have no secret and the device grant does not use PKCE.
        </p>
        <p>
          Codes are short by design, so the server limits attempts per address and per code, and a code is burned after
          a handful of wrong ones.
        </p>
      </div>

      <DeviceDemo
        applications={applications}
        loadError={listed.ok ? undefined : listed.error}
        flow={flow}
        secretKeyPresent={secretKeyPresent}
        instanceUrl={resolveApiUrl()}
      />
    </div>
  );
}
