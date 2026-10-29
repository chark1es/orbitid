import { PageHeader } from "@/components/page-header";
import { CopyButton } from "@/components/copy-button";
import { StatusChip } from "@/components/status-chip";
import { WebhookControls } from "@/components/webhooks/webhook-controls";
import { WebhookLive } from "@/components/webhooks/webhook-live";
import { currentOrigin, readSecretKey } from "@/lib/env";
import { getEndpoint, verificationSecret } from "@/lib/webhook-store";

export const dynamic = "force-dynamic";

const SOURCE_LABEL = {
  env: "ORBITID_WEBHOOK_SECRET",
  form: "Pasted secret",
  endpoint: "Registered endpoint secret",
  none: "None",
} as const;

export default async function WebhooksPage() {
  const receiverUrl = `${await currentOrigin()}/api/webhooks`;
  const endpoint = getEndpoint();
  const secret = verificationSecret();
  const hasSecretKey = Boolean(readSecretKey());

  return (
    <div className="space-y-8">
      <PageHeader
        title="Webhooks"
        description="Receive signed events from the instance, register this site as an endpoint, and read what the instance recorded."
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          <WebhookLive />
        </div>

        <aside className="space-y-6">
          <section aria-labelledby="receiver-title" className="border">
            <div className="border-b px-4 py-3">
              <h2 id="receiver-title" className="text-base">
                Receiver
              </h2>
              <p className="text-xs text-muted-foreground">The URL the instance posts to. It verifies the signature.</p>
            </div>
            <dl className="divide-y">
              <div className="px-4 py-3">
                <dt className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">URL</dt>
                <dd className="mt-1 flex items-start gap-2">
                  <code className="font-data min-w-0 flex-1 text-xs break-all">{receiverUrl}</code>
                  <CopyButton value={receiverUrl} label="Copy URL" />
                </dd>
              </div>
              <div className="px-4 py-3">
                <dt className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Registered endpoint
                </dt>
                <dd className="mt-1 text-xs">
                  {endpoint ? (
                    <span className="flex flex-col gap-0.5">
                      <code className="font-data break-all">{endpoint.id}</code>
                      <span className="text-muted-foreground">{endpoint.url}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">None from this page. Register it below.</span>
                  )}
                </dd>
              </div>
              <div className="px-4 py-3">
                <dt className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Verification secret
                </dt>
                <dd className="mt-1 text-xs">
                  <StatusChip
                    kind={secret.source === "none" ? "needs-config" : "success"}
                    label={SOURCE_LABEL[secret.source]}
                  />
                  <p className="mt-1 text-muted-foreground">
                    First match wins: environment, pasted secret, registered endpoint. A wrong secret answers 400 with
                    invalid-signature.
                  </p>
                </dd>
              </div>
            </dl>
          </section>

          {!hasSecretKey ? (
            <section className="border px-4 py-3" aria-label="Secret key needed">
              <StatusChip kind="needs-config" label="Needs the secret key" />
              <p className="mt-1 text-sm">
                Set <code className="font-data">ORBITID_SECRET_KEY</code> in playground/.env.local to register an
                endpoint and read deliveries. The receiver and the event list still work.
              </p>
            </section>
          ) : null}

          <WebhookControls endpointId={endpoint?.id ?? null} />
        </aside>
      </div>
    </div>
  );
}
