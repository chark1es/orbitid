// Child process for the database-transfer tests. It boots a real app against the database in the job
// (a dialect the parent test process does not use) and talks to it over HTTP, so the data comes from
// the API and the verification exercises the migrated instance exactly like a running server would.
//
// Job on stdin:
//   { mode: "seed", databaseUrl, baseUrl, email, inviteeEmail, password, organizationName }
//   { mode: "verify", databaseUrl, baseUrl, email, password, organizationId, apiKeySecret, webhookEndpointId, webhookSecret }
import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import * as s from "../../src/db/schema";
import { decrypt } from "../../src/lib/crypto";
import { first } from "../../src/lib/db";
import { verifyPassword } from "../../src/services/passwords";
import { signUpUser, testClient, type TestClient } from "../core/helpers";

interface Job {
  mode: "seed" | "verify";
  databaseUrl: string;
  baseUrl: string;
  email: string;
  inviteeEmail?: string;
  password: string;
  organizationName?: string;
  organizationId?: string;
  apiKeySecret?: string;
  webhookEndpointId?: string;
  webhookSecret?: string;
}

const job = JSON.parse(await new Promise<string>((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
})) as Job;

const ctx = await createContext({ databaseUrl: job.databaseUrl, baseUrl: job.baseUrl, nodeEnv: "test" });
const app = createApp(ctx);

// The transfer tests exercise organizations and invitations, which are off by default.
await ctx.settings.update({ organizations: { enabled: true, creationEnabled: true } });

async function backend<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${ctx.env.secretKey}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as T };
}
async function enableTotp(client: TestClient): Promise<string> {
  const setup = await client.json<{ response: { secret: string } }>("/v1/client/me/totp", { body: {} });
  const secret = setup.response.secret;
  const verified = await client.json<{ response: { verified: boolean } }>("/v1/client/me/totp/attempt_verification", { body: { code: authenticator.generate(secret) } });
  if (!verified.response.verified) throw new Error("TOTP verification did not enable the factor");
  return secret;
}

/** Row counts per table, read straight from the database (rate limits are deliberately not copied). */
async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const [key, table] of Object.entries({
    users: s.users, emailAddresses: s.emailAddresses, clients: s.clients, sessions: s.sessions,
    organizations: s.organizations, organizationMemberships: s.organizationMemberships, organizationInvitations: s.organizationInvitations,
    invitations: s.invitations, webhookEndpoints: s.webhookEndpoints, webhookEvents: s.webhookEvents, webhookDeliveries: s.webhookDeliveries,
    apiKeys: s.apiKeys, oauthApplications: s.oauthApplications, signingKeys: s.signingKeys, auditLogs: s.auditLogs,
    rateLimits: s.rateLimits, roles: s.roles, permissions: s.permissions, instance: s.instance,
  })) result[key] = (await ctx.db.select().from(table as never)).length;
  return result;
}

try {
  if (job.mode === "seed") {
    const owner = await signUpUser(app, { email: job.email, password: job.password });
    const totpSecret = await enableTotp(owner.client);

    const org = await owner.client.json<{ response: { id: string } }>("/v1/client/organizations", { body: { name: job.organizationName ?? "Transfer Co" } });
    const invitation = await owner.client.json<{ response: { id: string } }>(`/v1/client/organizations/${org.response.id}/invitations`, {
      body: { email_address: job.inviteeEmail ?? "invitee@transfer.test", role: "org:member" },
    });

    const invitee = await signUpUser(app, { email: job.inviteeEmail ?? "invitee@transfer.test", password: job.password });
    // Verifying the invited address joins the organization on its own; accepting explicitly is then a no-op
    // (409), which is covered elsewhere. Either way the membership must exist.
    const accepted = await invitee.client.json<{ response?: { id: string }; errors?: { code: string }[] }>(`/v1/client/me/organization_invitations/${invitation.response.id}/accept`, { body: {} });
    const inviteeMemberships = await invitee.client.json<{ response: { id: string; organization: { id: string } }[] }>("/v1/client/me/organization_memberships");
    const inviteeMembership = inviteeMemberships.response.find((membership) => membership.organization.id === org.response.id);
    if (!inviteeMembership) throw new Error(`accepting the invitation failed: ${JSON.stringify(accepted)}`);
    // A second invitation that stays pending, so the export has one of each status.
    const pendingInvitation = await owner.client.json<{ response: { id: string } }>(`/v1/client/organizations/${org.response.id}/invitations`, {
      body: { email_address: "pending@transfer.test", role: "org:admin" },
    });

    // Instance-level invitation (its plaintext token is only sent by mail, so keep what the mail recorded).
    const instanceInvite = await backend<{ id: string; email_address: string }>("/v1/invitations", { body: { email_address: "instance@transfer.test" } });

    const webhook = await backend<{ id: string; secret: string }>("/v1/webhooks/endpoints", { body: { url: "https://hooks.transfer.test/orbitid", event_types: [] } });
    const apiKey = await backend<{ id: string; secret: string }>("/v1/api_keys", { body: { name: "Transfer key", subject: owner.userId } });
    const oauthApp = await backend<{ id: string; client_id: string }>("/v1/oauth_applications", { body: { name: "Transfer app", redirect_uris: ["https://app.transfer.test/callback"] } });

    // A normal write after the endpoint exists records a webhook event and a pending delivery (no worker
    // runs here, so nothing is sent anywhere).
    await backend(`/v1/users/${owner.userId}`, { method: "PATCH", body: { public_metadata: { plan: "transfer" } } });

    process.stdout.write(`${JSON.stringify({
      ok: true,
      dialect: ctx.database.dialect,
      userId: owner.userId,
      inviteeUserId: invitee.userId,
      sessionId: owner.sessionId,
      organizationId: org.response.id,
      membershipId: inviteeMembership.id,
      invitationId: invitation.response.id,
      pendingInvitationId: pendingInvitation.response.id,
      instanceInvitationId: instanceInvite.body.id,
      webhookEndpointId: webhook.body.id,
      webhookSecret: webhook.body.secret,
      apiKeyId: apiKey.body.id,
      apiKeySecret: apiKey.body.secret,
      oauthApplicationId: oauthApp.body.id,
      totpSecret,
      counts: await counts(),
    })}\n`);
  } else {
    // Row counts first: the sign-in below legitimately writes clients, sessions and sign-ins.
    const countsBefore = await counts();

    // Password + MFA sign-in through the Frontend API, against the database that was just imported.
    const client = testClient(app);
    const created = await client.json<{ response: { id: string; status: string } }>("/v1/client/sign_ins", {
      body: { identifier: job.email, password: job.password },
    });
    const passwordVerified = created.response.status === "needs_second_factor";

    const user = first(await ctx.db
      .select()
      .from(s.users)
      .innerJoin(s.emailAddresses, eq(s.emailAddresses.userId, s.users.id))
      .where(eq(s.emailAddresses.email, job.email.toLowerCase())))!.users;

    // The stored digest is what a migrated database has to preserve.
    const digestVerifies = await verifyPassword(user.passwordHash, job.password);

    let totpCodeAccepted = false;
    if (created.response.status === "needs_second_factor") {
      await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, { body: { strategy: "totp" } });
      const secret = decrypt(ctx.env.encryptionKey, user.totpSecretEnc!);
      const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
        body: { strategy: "totp", code: authenticator.generate(secret) },
      });
      totpCodeAccepted = done.response.status === "complete";
    }

    const me = totpCodeAccepted ? await client.json<{ response: { id: string } }>("/v1/client/me") : null;
    const organizations = totpCodeAccepted
      ? await client.json<{ response: { organization: { id: string } }[] }>("/v1/client/me/organization_memberships")
      : { response: [] };

    const apiKey = job.apiKeySecret ? await backend<{ id: string }>("/v1/api_keys/verify", { body: { secret: job.apiKeySecret } }) : null;    const webhookSecret = job.webhookEndpointId
      ? await backend<{ secret: string }>(`/v1/webhooks/endpoints/${job.webhookEndpointId}/secret`)
      : null;

    const signingKey = first(await ctx.db.select().from(s.signingKeys).where(eq(s.signingKeys.active, true)));
    let signingKeyReadable = false;
    if (signingKey) {
      const jwk = JSON.parse(decrypt(ctx.env.encryptionKey, signingKey.privateJwkEnc)) as { kty?: string };
      signingKeyReadable = jwk.kty === "RSA";
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      dialect: ctx.database.dialect,
      passwordVerified,
      digestVerifies,
      totpCodeAccepted,
      userId: me?.response.id ?? null,
      userIdMatches: me?.response.id === user.id,
      inOrganization: job.organizationId ? organizations.response.some((membership) => membership.organization.id === job.organizationId) : null,
      apiKeyVerifies: apiKey?.status === 200,
      webhookSecretMatches: webhookSecret?.status === 200 ? webhookSecret.body.secret === job.webhookSecret : false,
      signingKeyReadable,
      counts: countsBefore,
    })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined })}\n`);
  process.exitCode = 1;
} finally {
  await ctx.close();
}
