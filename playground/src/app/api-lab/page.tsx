import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";
import { ApiLab } from "@/components/api-lab";

export default function ApiLabPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="API lab"
        description="Call three route handlers with and without a bearer token. The status line shows where auth() stops the request."
      />
      <ProviderGate
        title="The API lab needs a publishable key"
        description="It reads the session JWT through useAuth().getToken(). Without the key there is no session to send."
      >
        <div className="mb-6 border px-4 py-3 text-sm text-muted-foreground">
          <p>
            Calls without a token omit cookies, so the browser session cannot authenticate them. Calls with a token send
            the JWT from <code className="font-data">useAuth().getToken()</code> in an Authorization header.
          </p>
        </div>
        <ApiLab />
      </ProviderGate>
    </div>
  );
}
