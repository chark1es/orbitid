// OWNER: worker "core" (W1) — /v1/client (client, sessions, tokens, touch/end/remove)
import { Hono, type Context } from "hono";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError, type SessionJSON, type VerificationJSON } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { parseBody } from "../lib/http";
import { hit } from "../lib/rate-limit";
import { serializeSession } from "../serializers";
import { signSessionToken } from "../services/tokens";
import { consumeBackupCode, userHasMfa, verifyTotp, verifiedSecondFactorPhones } from "../services/mfa";
import { verifyPassword } from "../services/passwords";
import { endSession, evaluateSessionStatus, markSessionReverified, requireSession, touchSession } from "../services/sessions";
import { recordFailedAttempt, resetFailedAttempts } from "../services/users";
import { getUserById } from "../services/users";
import { sendEmail, sendSms } from "../services/mail";
import { clientAzp, clearClientCookie, getOrCreateClient, serializeClient } from "./auth/client-auth";
import { verificationAges } from "./auth/reverification";
import { checkCode, getVerification, issueVerification, verificationJSON } from "./auth/verifications";

const touchSchema = z.object({ active_organization_id: z.string().nullish() });
const tokenSchema = z.object({ template: z.string().nullish(), skip_cache: z.boolean().optional() });
const verifySchema = z.object({ level: z.enum(["first_factor", "second_factor", "multi_factor"]).optional() });
const prepareFirstSchema = z.object({
  strategy: z.enum(["email_code", "phone_code", "password"]).optional(),
  email_address_id: z.string().optional(),
  phone_number_id: z.string().optional(),
});
const attemptFirstSchema = z.object({
  strategy: z.enum(["email_code", "phone_code", "password"]).optional(),
  code: z.string().optional(),
  password: z.string().optional(),
});
const prepareSecondSchema = z.object({ strategy: z.enum(["totp", "phone_code", "backup_code"]), phone_number_id: z.string().optional() });
const attemptSecondSchema = z.object({ strategy: z.enum(["totp", "phone_code", "backup_code"]), code: z.string().min(1) });

const sessionVerification = (ctx: AppContext, sessionId: string): VerificationJSON | null => {
  const row = getVerification(ctx, "reverify", sessionId);
  return verificationJSON(row);
};

const withVerification = (ctx: AppContext, session: SessionJSON, extra?: VerificationJSON | null): SessionJSON & { verification: VerificationJSON | null } => ({
  ...session,
  verification: extra ?? sessionVerification(ctx, session.id),
});

/** Maps a file extension to a content type (uploads only ever get image types). */
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/", async (c) => {
    const client = getOrCreateClient(ctx, c);
    const json = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: json, client: json });
  });

  app.delete("/", async (c) => {
    const client = getOrCreateClient(ctx, c);
    const rows = ctx.db.select().from(s.sessions).where(eq(s.sessions.clientId, client.id)).all();
    for (const row of rows) {
      if (row.status === "active" || row.status === "pending") await endSession(ctx, row, "removed");
    }
    ctx.db.update(s.clients).set({ lastActiveSessionId: null, updatedAt: Date.now() }).where(eq(s.clients.id, client.id)).run();
    clearClientCookie(c, ctx);
    const fresh = ctx.db.select().from(s.clients).where(eq(s.clients.id, client.id)).get()!;
    const json = await serializeClient(ctx, fresh, { azp: clientAzp(c) });
    return c.json({ response: json, client: json });
  });

  app.get("/sessions", async (c) => {
    const client = requireClientRow(ctx, c);
    const rows = ctx.db.select().from(s.sessions).where(eq(s.sessions.clientId, client.id)).orderBy(desc(s.sessions.createdAt)).all();
    const response: SessionJSON[] = [];
    for (const stored of rows) {
      const status = evaluateSessionStatus(ctx, stored);
      if (status === "expired") continue;
      const row = { ...stored, status };
      let token: string | null = null;
      if (status === "active" || status === "pending") {
        try { token = await signSessionToken(ctx, row.id, { azp: clientAzp(c) }); } catch { token = null; }
      }
      response.push(serializeSession(ctx, row, { withUser: true, lastToken: token }));
    }
    return c.json({ response });
  });

  app.post("/sessions/:id/touch", async (c) => {
    const client = requireClientRow(ctx, c);
    const row = requireSession(ctx, client.id, sessionParam(c));
    const body = await parseBody(c, touchSchema);
    const updated = await touchSession(ctx, row, { organizationId: body.active_organization_id ?? undefined });
    const json = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: serializeSession(ctx, updated, { withUser: true }), client: json });
  });

  const end = (status: "ended" | "removed") => async (c: Context) => {
    const client = requireClientRow(ctx, c);
    const row = requireSession(ctx, client.id, sessionParam(c));
    const updated = await endSession(ctx, row, status);
    const json = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: serializeSession(ctx, updated, { withUser: true }), client: json });
  };
  app.post("/sessions/:id/end", end("ended"));
  app.post("/sessions/:id/remove", end("removed"));

  const mintToken = async (c: Context, template?: string) => {
    const client = requireClientRow(ctx, c);
    const row = requireSession(ctx, client.id, sessionParam(c));
    hit(ctx, `session_token:${client.id}`, 300, 60_000);
    const jwt = await signSessionToken(ctx, row.id, { template, azp: clientAzp(c) });
    return c.json({ jwt });
  };
  app.post("/sessions/:id/tokens", async (c) => {
    const body = await parseBody(c, tokenSchema);
    return mintToken(c, body.template ?? undefined);
  });
  app.post("/sessions/:id/tokens/:template", (c) => mintToken(c, c.req.param("template")));

  // ───────────── session reverification ─────────────
  app.post("/sessions/:id/verify", async (c) => {
    const client = requireClientRow(ctx, c);
    const row = requireSession(ctx, client.id, sessionParam(c));
    await parseBody(c, verifySchema);
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({
      response: withVerification(ctx, serializeSession(ctx, row, { withUser: true }), { status: "unverified", strategy: "first_factor", attempts: null, expire_at: null }),
      client: clientJson,
    });
  });

  app.post("/sessions/:id/verify/prepare_first_factor", async (c) => {
    const client = requireClientRow(ctx, c);
    const row = requireSession(ctx, client.id, sessionParam(c));
    const body = await parseBody(c, prepareFirstSchema);
    hit(ctx, `reverify_prepare:${client.id}`, 30, 60_000);
    const user = userOfSession(ctx, row);
    const strategy = body.strategy ?? "email_code";
    const emails = ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.userId, user.id), eq(s.emailAddresses.verified, true))).all();
    const phones = verifiedSecondFactorPhones(ctx, user);
    let verification: VerificationJSON | null = null;
    if (strategy === "email_code") {
      const email = body.email_address_id ? emails.find((e) => e.id === body.email_address_id) : emails[0];
      if (!email) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This user has no verified email address");
      const issued = issueVerification(ctx, { purpose: "reverify", strategy: "email_code", identifier: email.email, ownerId: row.id, lifetimeSeconds: ctx.settings.get().email.codeLifetimeSeconds });
      await sendEmail(ctx, { to: email.email, template: "verification_code", vars: { code: issued.code, expires_in_minutes: Math.round(ctx.settings.get().email.codeLifetimeSeconds / 60) } });
      verification = verificationJSON(issued.row);
    } else if (strategy === "phone_code") {
      const phone = body.phone_number_id ? phones.find((p) => p.id === body.phone_number_id) : phones[0];
      if (!phone) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This user has no verified phone number");
      const issued = issueVerification(ctx, { purpose: "reverify", strategy: "phone_code", identifier: phone.phone, ownerId: row.id, lifetimeSeconds: ctx.settings.get().email.codeLifetimeSeconds });
      await sendSms(ctx, phone.phone, `Your ${ctx.settings.get().application.name} verification code is ${issued.code}`);
      verification = verificationJSON(issued.row);
    } else {
      if (!user.passwordHash) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This user has no password");
      verification = { status: "unverified", strategy: "password", attempts: null, expire_at: null };
    }
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: verification, client: clientJson });
  });

  app.post("/sessions/:id/verify/attempt_first_factor", async (c) => {
    const client = requireClientRow(ctx, c);
    const row = requireSession(ctx, client.id, sessionParam(c));
    const body = await parseBody(c, attemptFirstSchema);
    hit(ctx, `reverify_attempt:${client.id}`, 60, 60_000);
    const user = userOfSession(ctx, row);
    const strategy = body.strategy ?? "email_code";
    if (strategy === "password") {
      if (!user.passwordHash || !body.password || !(await verifyPassword(user.passwordHash, body.password))) {
        recordFailedAttempt(ctx, user.id);
        throw new OrbitError(422, ErrorCodes.form_password_incorrect, "Password is incorrect", { param_name: "password" });
      }
      resetFailedAttempts(ctx, user.id);
    } else {
      const verification = getVerification(ctx, "reverify", row.id);
      checkCode(ctx, verification, body.code);
    }
    markSessionReverified(ctx, row.id, "first_factor");
    const verification = strategy === "password"
      ? { status: "verified" as const, strategy: "password", attempts: null, expire_at: null }
      : verificationJSON(getVerification(ctx, "reverify", row.id));
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: verification, client: clientJson });
  });

  app.post("/sessions/:id/verify/prepare_second_factor", async (c) => {
    const client = requireClientRow(ctx, c);
    const row = requireSession(ctx, client.id, sessionParam(c));
    const body = await parseBody(c, prepareSecondSchema);
    const user = userOfSession(ctx, row);
    if (!userHasMfa(ctx, user)) throw new OrbitError(400, ErrorCodes.mfa_not_enabled, "This user has not enabled MFA");
    let verification: VerificationJSON | null = { status: "unverified", strategy: body.strategy, attempts: null, expire_at: null };
    if (body.strategy === "phone_code") {
      const phones = verifiedSecondFactorPhones(ctx, user);
      const phone = body.phone_number_id ? phones.find((p) => p.id === body.phone_number_id) : phones.find((p) => p.defaultSecondFactor) ?? phones[0];
      if (!phone) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This user has no verified second-factor phone number");
      const issued = issueVerification(ctx, { purpose: "reverify", strategy: "phone_code", identifier: phone.phone, ownerId: row.id, lifetimeSeconds: ctx.settings.get().email.codeLifetimeSeconds });
      await sendSms(ctx, phone.phone, `Your ${ctx.settings.get().application.name} verification code is ${issued.code}`);
      verification = verificationJSON(issued.row);
    } else if (body.strategy === "totp" && !user.totpVerified) {
      throw new OrbitError(400, ErrorCodes.totp_not_enabled, "TOTP is not enabled for this user");
    } else if (body.strategy === "backup_code" && !user.backupCodes?.length) {
      throw new OrbitError(400, ErrorCodes.mfa_not_enabled, "No backup codes available");
    }
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: verification, client: clientJson });
  });

  app.post("/sessions/:id/verify/attempt_second_factor", async (c) => {
    const client = requireClientRow(ctx, c);
    const row = requireSession(ctx, client.id, sessionParam(c));
    const body = await parseBody(c, attemptSecondSchema);
    hit(ctx, `reverify_2fa:${client.id}`, 60, 60_000);
    const user = userOfSession(ctx, row);
    if (body.strategy === "totp") {
      if (!verifyTotp(ctx, user, body.code)) throw new OrbitError(422, ErrorCodes.form_code_incorrect, "That verification code is incorrect", { param_name: "code" });
    } else if (body.strategy === "backup_code") {
      if (!consumeBackupCode(ctx, user, body.code)) throw new OrbitError(422, ErrorCodes.form_code_incorrect, "That backup code is incorrect or already used", { param_name: "code" });
    } else {
      const verification = getVerification(ctx, "reverify", row.id);
      checkCode(ctx, verification, body.code);
    }
    markSessionReverified(ctx, row.id, "second_factor");
    const verification = body.strategy === "phone_code"
      ? verificationJSON(getVerification(ctx, "reverify", row.id))
      : { status: "verified" as const, strategy: body.strategy, attempts: null, expire_at: null };
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: verification, client: clientJson });
  });

  // Profile images (stored under <dataDir>/uploads by /me/profile_image).
  app.get("/images/:file", (c) => {
    const file = c.req.param("file");
    if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes("..")) throw new OrbitError(404, ErrorCodes.resource_not_found, "Image not found");
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    const type = IMAGE_TYPES[ext];
    if (!type) throw new OrbitError(404, ErrorCodes.resource_not_found, "Image not found");
    let data: Buffer;
    try {
      data = readFileSync(resolve(ctx.env.dataDir, "uploads", file));
    } catch {
      throw new OrbitError(404, ErrorCodes.resource_not_found, "Image not found");
    }
    c.header("Content-Type", type);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(new Uint8Array(data).buffer);
  });

  /** Verification ages for the session (used by `<UserProfile>` / `useReverification`). */
  app.get("/sessions/:id/verification", (c) => {
    const client = requireClientRow(ctx, c);
    const row = requireSession(ctx, client.id, sessionParam(c));
    return c.json({ response: verificationAges(row) });
  });

  return app;
}

/** Client must exist (the SDK always calls GET /client first). */
function requireClientRow(ctx: AppContext, c: Context) {
  return getOrCreateClient(ctx, c);
}

function sessionParam(c: Context): string {
  const id = c.req.param("id");
  if (!id) throw new OrbitError(404, ErrorCodes.resource_not_found, "Session not found");
  return id;
}

/** User of a session row (with usability checks). */
function userOfSession(ctx: AppContext, row: typeof s.sessions.$inferSelect) {
  const user = getUserById(ctx, row.userId);
  if (!user) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Not signed in");
  if (user.banned) throw new OrbitError(403, ErrorCodes.user_banned, "This user has been banned");
  return user;
}
