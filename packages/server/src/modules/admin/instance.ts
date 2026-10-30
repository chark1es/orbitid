// Backend API instance settings, testing tokens, audit logs, stats.
import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import { eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError, type InstanceSettings } from "@orbitid/shared";
import { parseBody, zodToOrbit, clientIp } from "../../lib/http";
import { randomToken, sha256 } from "../../lib/crypto";
import { maskSecrets, unmaskSettingsPatch } from "../../lib/secrets";
import { newId } from "../../lib/ids";
import * as s from "../../db/schema";
import { parseEmailFrom, parseSmtpUrl } from "../../lib/email-format";
import { sendEmail, sendTestEmail } from "../../services/mail";
import { hit } from "../../lib/rate-limit";
import { audit, listAuditLogs } from "../../services/audit";
import { instanceStats } from "../../services/stats";
import { rotateSigningKey } from "../../services/tokens";
import type { AppContext, DeepPartial } from "../../context";
import { listParams } from "./shared";
import { first } from "../../lib/db";

const TESTING_TOKEN_TTL_MS = 3_600_000;

type SettingsTree = Record<string, unknown>;

const INSTANCE_URL_FIELDS = ["homeUrl", "logoUrl", "termsUrl", "privacyUrl"] as const;
const INSTANCE_URL_LIST_FIELDS = ["allowedOrigins", "allowedRedirectOrigins"] as const;

function assertInstanceUrls(patch: SettingsTree): void {
  const application = patch.application as SettingsTree | undefined;
  if (!application) return;
  for (const field of INSTANCE_URL_FIELDS) {
    const value = application[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/i.test(value)) {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `application.${field} must be an absolute http(s) URL.`, { param_name: `application.${field}` });
    }
  }
  for (const field of INSTANCE_URL_LIST_FIELDS) {
    const value = application[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `application.${field} must be an array of URLs.`, { param_name: `application.${field}` });
    }
    value.forEach((origin, index) => {
      if (typeof origin !== "string" || !/^https?:\/\/[^\s/]+/i.test(origin)) {
        throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `application.${field}[${index}] must be an absolute http(s) origin.`, { param_name: `application.${field}` });
      }
    });
  }
}

/** Rejects SMTP URLs and From headers that would fail at delivery time, before they are persisted. */
function assertEmailSettings(patch: SettingsTree): void {
  const email = patch.email as SettingsTree | undefined;
  if (!email) return;
  if (email.from !== undefined) {
    if (typeof email.from !== "string") {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "email.from must be a string", { param_name: "email.from" });
    }
    parseEmailFrom(email.from);
  }
  if (email.smtpUrl !== undefined) {
    if (typeof email.smtpUrl !== "string") {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "email.smtpUrl must be a string", { param_name: "email.smtpUrl" });
    }
    // An empty URL is the way to clear it; anything else must be a valid smtp(s):// URL.
    if (email.smtpUrl.trim()) parseSmtpUrl(email.smtpUrl);
  }
  for (const field of ["resendApiKey"] as const) {
    const value = email[field];
    if (value !== undefined && typeof value !== "string") {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `email.${field} must be a string`, { param_name: `email.${field}` });
    }
    if (typeof value === "string" && /\r|\n/.test(value)) {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `email.${field} must not contain line breaks`, { param_name: `email.${field}` });
    }
  }
}

/**
 * The organization creator/default role settings are keys, not free text: a key that does not name an existing
 * organization role would make every new membership fall back silently (`creatorRoleKey`/`defaultRoleKey`), so the
 * save is refused instead. Scope and syntax are checked by the pure settings policy; existence needs the database.
 */
async function assertOrganizationRoleSettings(ctx: AppContext, patch: SettingsTree): Promise<void> {
  const organizations = patch.organizations as SettingsTree | undefined;
  if (!organizations) return;
  for (const field of ["creatorRole", "defaultRole"] as const) {
    const key = organizations[field];
    if (key === undefined) continue;
    if (typeof key !== "string" || !key) {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `organizations.${field} must be a role key`, { param_name: `organizations.${field}` });
    }
    const role = first(await ctx.db.select().from(s.roles).where(eq(s.roles.key, key)));
    if (!role) {
      throw new OrbitError(422, ErrorCodes.org_role_not_found, `organizations.${field} names "${key}", which does not exist. Create the role first.`, { param_name: `organizations.${field}` });
    }
  }
}

/** Accepts a partial settings tree (`settings.update` deep-merges it and validates against the schema). */
function instanceJson(ctx: AppContext) {
  const settings = ctx.settings.get();
  return {
    object: "instance" as const,
    id: "default",
    environment_type: ctx.env.nodeEnv === "production" ? "production" : "development",
    publishable_key: ctx.publishableKey,
    database: { dialect: ctx.database.dialect, driver: ctx.database.driver, label: ctx.database.label },
    ...maskSecrets(settings),
  };
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/instance", (c) => c.json(instanceJson(ctx)));

  app.patch("/instance", async (c) => {
    const body = (await parseBody(c, z.record(z.string(), z.unknown()))) as SettingsTree;
    // Masks and unchanged echoes are dropped, so a full-object round trip keeps the stored credentials.
    const patch = unmaskSettingsPatch(ctx.settings.get(), body);
    assertInstanceUrls(patch);
    assertEmailSettings(patch);
    await assertOrganizationRoleSettings(ctx, patch);
    try {
      // `settings.update` deep-merges and re-validates the whole tree through the zod schema.
      await ctx.settings.update(patch as DeepPartial<InstanceSettings>);
    } catch (err) {
      if (err instanceof ZodError) throw zodToOrbit(err);
      throw err;
    }
    await audit(ctx, { actor: "secret_key", action: "instance.updated", targetType: "instance", targetId: "default", metadata: { fields: Object.keys(patch) } });
    return c.json(instanceJson(ctx));
  });

  app.post("/instance/test_email", async (c) => {
    const body = await parseBody(c, z.object({ to: z.string().email().optional() }));
    const settings = ctx.settings.get();
    // `email.from` is a formatted header ("OrbitID <no-reply@localhost>"), not a recipient; hand the send path the
    // bare address so the default fallback is not rejected as malformed.
    const fallback = parseEmailFrom(settings.email.from.trim() || ctx.env.emailFrom || "no-reply@localhost").address;
    const to = body.to ?? settings.application.supportEmail ?? fallback;
    // Legacy compatibility route: same send path, and it reports the typed outcome instead of claiming a delivery
    // that did not happen. Nothing is written to the console either way.
    const delivery = await sendEmail(ctx, { to, template: "verification_code", vars: { code: "123456", app_name: settings.application.name } });
    if (!delivery.delivered) {
      const code = delivery.error?.code ?? "email_delivery_failed";
      // A bad recipient is the caller's mistake, not a broken transport: keep the 422 the OpenAPI contract promises.
      const status = code === ErrorCodes.form_param_format_invalid || code === ErrorCodes.form_param_missing ? 422 : 503;
      throw new OrbitError(status, code, delivery.error?.message ?? "Email delivery failed.");
    }
    return c.json({ status: "ok", to });
  });

  /** Sends a real test message through the resolved transport and reports which provider it used. */
  app.post("/instance/email_test", async (c) => {
    const body = await parseBody(c, z.object({ to: z.string() }));
    await hit(ctx, `instance:email_test:${clientIp(c)}`, 10, 60_000);
    await hit(ctx, "instance:email_test", 60, 60_000);
    // Delivery failures surface as a 502 `email_delivery_failed` from the mail service, with the API key redacted.
    const { provider } = await sendTestEmail(ctx, body.to);
    await audit(ctx, { actor: "secret_key", action: "instance.email_test", targetType: "instance", targetId: "default", metadata: { provider } });
    return c.json({ provider, ok: true as const });
  });

  app.post("/instance/signing_keys/rotate", async (c) => {
    // services/tokens.ts owns the signing keys; report the stored row so the shape stays stable.
    const { kid } = await rotateSigningKey(ctx);
    const key = first(await ctx.db.select().from(s.signingKeys).where(eq(s.signingKeys.kid, kid)));
    await audit(ctx, { actor: "secret_key", action: "instance.signing_key.rotated", targetType: "instance", targetId: "default", metadata: { kid } });
    return c.json({ object: "signing_key", kid, algorithm: key?.alg ?? "RS256", active: key?.active ?? true });
  });

  app.post("/testing_tokens", async (c) => {
    if (!ctx.settings.get().security.testingTokensEnabled) {
      throw new OrbitError(400, ErrorCodes.not_allowed_access, "Testing tokens are disabled on this instance.");
    }
    const token = `tt_${randomToken(32)}`;
    const now = Date.now();
    const expiresAt = now + TESTING_TOKEN_TTL_MS;
    await ctx.db
                  .insert(s.verifications)
                  .values({
                    id: newId(ID_PREFIX.verification),
                    purpose: "testing_token",
                    strategy: "testing_token",
                    identifier: "",
                    ownerId: "",
                    tokenHash: sha256(token),
                    expiresAt,
                    createdAt: now,
                  });
    await audit(ctx, { actor: "secret_key", action: "testing_token.created", targetType: "instance", targetId: "default" });
    return c.json({ object: "testing_token", token, expires_at: expiresAt });
  });

  app.get("/audit_logs", async (c) => {
    const { limit, offset, order_by } = listParams(c);
    const numeric = (name: string) => {
      const raw = c.req.query(name);
      const value = raw === undefined ? undefined : Number(raw);
      return value === undefined || Number.isNaN(value) ? undefined : value;
    };
    const result = await listAuditLogs(ctx, {
          limit,
          offset,
          orderBy: order_by,
          actor: c.req.query("actor") || undefined,
          action: c.req.query("action") || undefined,
          targetType: c.req.query("target_type") || undefined,
          targetId: c.req.query("target_id") || undefined,
          after: numeric("after"),
          before: numeric("before"),
        });
    return c.json(result);
  });

  app.get("/stats", async (c: Context) => c.json(await instanceStats(ctx)));

  return app;
}
