import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";
import { ApiLab } from "@/components/api-lab";

export default function ApiLabPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="API lab"
        description="Call the test site's route handlers and see the status line, headers and body. Some of them call the instance's new endpoints from the server."
      />
      <ProviderGate
        title="The API lab needs a publishable key"
        description="It reads the session JWT through useAuth().getToken(). Without the key there is no session to send."
      >
        <div className="mb-6 space-y-1 border px-4 py-3 text-sm text-muted-foreground">
          <p>
            Calls without a token omit cookies, so the browser session cannot authenticate them. Calls with a token send
            the JWT from <code className="font-data">useAuth().getToken()</code> in an Authorization header.
          </p>
          <p>
            The handshake, device and email routes run on the dev server: they call the instance directly, and the email
            test uses <code className="font-data">ORBITID_SECRET_KEY</code> there so the key never reaches the browser.
          </p>
        </div>
        <ApiLab />
      </ProviderGate>
    </div>
  );
}
