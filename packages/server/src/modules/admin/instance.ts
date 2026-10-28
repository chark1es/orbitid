// Backend API instance settings, testing tokens, audit logs, stats.
import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import { eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError, type InstanceSettings } from "@orbitid/shared";
import { parseBody, zodToOrbit } from "../../lib/http";
import { randomToken, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import * as s from "../../db/schema";
import { sendEmail } from "../../services/mail";
import { audit, listAuditLogs } from "../../services/audit";
import { instanceStats } from "../../services/stats";
import { rotateSigningKey } from "../../services/tokens";
import type { AppContext, DeepPartial } from "../../context";
import { listParams } from "./shared";
import { first } from "../../lib/db";

const MASK = "••••";
const TESTING_TOKEN_TTL_MS = 3_600_000;

type SettingsTree = Record<string, unknown>;

/** Deep clone with secret fields replaced by `••••` and sibling `<field>Set` booleans. */
function maskSettings(settings: InstanceSettings): SettingsTree {
  const copy = JSON.parse(JSON.stringify(settings)) as SettingsTree;
  const maskField = (owner: SettingsTree | undefined, key: string) => {
    if (!owner) return;
    const value = owner[key];
    owner[`${key}Set`] = typeof value === "string" && value.length > 0;
    if (typeof value === "string" && value.length > 0) owner[key] = MASK;
  };
  maskField(copy.email as SettingsTree, "smtpUrl");
  maskField(copy.sms as SettingsTree, "twilioAuthToken");
  maskField(copy.security as SettingsTree, "captchaSecret");
  for (const provider of Object.values((copy.social ?? {}) as Record<string, SettingsTree>)) maskField(provider, "clientSecret");
  return copy;
}

/** Drops `*Set` helper keys and masked values so a round-tripped GET/PATCH keeps the stored secrets. */
function stripMasked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMasked);
  if (value && typeof value === "object") {
    const out: SettingsTree = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.endsWith("Set")) continue;
      const cleaned = stripMasked(item);
      if (cleaned === MASK) continue;
      out[key] = cleaned;
    }
    return out;
  }
  return value;
}

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

/** Accepts a partial settings tree (`settings.update` deep-merges it and validates against the schema). */
function instanceJson(ctx: AppContext) {
  const settings = ctx.settings.get();
  return {
    object: "instance" as const,
    id: "default",
    environment_type: ctx.env.nodeEnv === "production" ? "production" : "development",
    publishable_key: ctx.publishableKey,
    database: { dialect: ctx.database.dialect, driver: ctx.database.driver, label: ctx.database.label },
    ...maskSettings(settings),
  };
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/instance", (c) => c.json(instanceJson(ctx)));

  app.patch("/instance", async (c) => {
    const body = (await parseBody(c, z.record(z.string(), z.unknown()))) as SettingsTree;
    const patch = stripMasked(body) as SettingsTree;
    assertInstanceUrls(patch);
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
    const to = body.to ?? settings.application.supportEmail ?? settings.email.from;
    await sendEmail(ctx, { to, template: "verification_code", vars: { code: "123456", app_name: settings.application.name } });
    return c.json({ status: "ok", to });
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
