// /v1/client/sign_ups
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { clientIp, parseBody } from "../lib/http";
import { hit } from "../lib/rate-limit";
import { assertPasswordValid, hashPassword } from "../services/passwords";
import { verifyCaptcha } from "../services/captcha";
import { sendEmail, sendSms } from "../services/mail";
import { normalizeEmail, normalizePhone, isValidEmail, assertUsernameAvailable } from "../services/users";
import { redeemTicket } from "../services/restrictions";
import { isProviderEnabled, providerKeyFromStrategy } from "../services/oauth-providers";
import { clientAzp, getOrCreateClient, rotateClientTokenOnSignIn, serializeClient } from "./auth/client-auth";
import { clearTransferProfile, latestTransferableSignIn, readTransferProfile } from "./auth/signin-core";
import {
  applyExternalProfile, asSignUpFields, asSignUpVerifications, assertSignUpIdentifiers, buildSignUpJSON,
  completeSignUp, maybeCompleteSignUp, saveSignUp,
  type SignUpFields, type SignUpRow, type SignUpVerifications, type VerificationSnapshot,
} from "./auth/signup-core";
import { checkCode, getVerification, issueVerification, magicLinkUrl } from "./auth/verifications";
import { createOAuthAuthorization } from "./auth/oauth-flow";
import { validateRedirectUrl } from "./auth/redirects";
import { zBool, zMetadata } from "./auth/forms";
import { first } from "../lib/db";

// Every string a caller can send is bounded; the 1 MB body cap is the outer limit, these are the per-field ones.
const shortText = (max: number) => z.string().max(max);
const createSchema = z.object({
  email_address: shortText(320).optional(),
  phone_number: shortText(32).optional(),
  username: shortText(64).optional(),
  first_name: shortText(256).optional(),
  last_name: shortText(256).optional(),
  password: shortText(256).optional(),
  external_id: shortText(256).nullish(),
  strategy: shortText(64).optional(),
  redirect_url: shortText(2048).optional(),
  action_complete_redirect_url: shortText(2048).optional(),
  ticket: shortText(512).optional(),
  transfer: zBool.optional(),
  unsafe_metadata: zMetadata.optional(),
  legal_accepted: zBool.optional(),
  captcha_token: shortText(4096).optional(),
});

const updateSchema = z.object({
  email_address: shortText(320).nullish(),
  phone_number: shortText(32).nullish(),
  username: shortText(64).nullish(),
  first_name: shortText(256).nullish(),
  last_name: shortText(256).nullish(),
  password: shortText(256).nullish(),
  external_id: shortText(256).nullish(),
  unsafe_metadata: zMetadata.optional(),
  legal_accepted: zBool.optional(),
  redirect_url: shortText(2048).optional(),
  captcha_token: shortText(4096).optional(),
});

const prepareSchema = z.object({ strategy: shortText(64).optional(), redirect_url: shortText(2048).optional(), captcha_token: shortText(4096).optional() });
const attemptSchema = z.object({ strategy: shortText(64).optional(), code: shortText(64).optional() });

const captchaToken = (c: Context, body: { captcha_token?: string }) => body.captcha_token ?? c.req.header("x-captcha-token") ?? undefined;

export default function routes(ctx: AppContext) {
  const app = new Hono();

  const reload = async (id: string) => first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.id, id)))!;

  const load = async (clientId: string, id: string): Promise<SignUpRow> => {
    const row = first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.id, id)));
    if (!row || row.clientId !== clientId) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-up not found");
    return row;
  };

  const respond = async (c: Context, clientId: string, row: SignUpRow) => {
    const client = first(await ctx.db.select().from(s.clients).where(eq(s.clients.id, clientId)))!;
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: await buildSignUpJSON(ctx, row), client: clientJson });
  };

  const abandonPrevious = async (clientId: string) => {
    await ctx.db.update(s.signUps).set({ status: "abandoned", updatedAt: Date.now() }).where(eq(s.signUps.clientId, clientId));
  };

  const applyBodyFields = async (fields: SignUpFields, body: Partial<z.infer<typeof updateSchema>> & { unsafe_metadata?: Record<string, unknown> }): Promise<SignUpFields> => {
    const st = ctx.settings.get();
    const next: SignUpFields = { ...fields };
    if (body.email_address !== undefined && body.email_address !== null) {
      if (!st.attributes.emailAddress.enabled) throw new OrbitError(422, ErrorCodes.form_param_unknown, "Email addresses are disabled for this instance", { param_name: "email_address" });
      const email = normalizeEmail(body.email_address);
      if (!isValidEmail(email)) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "email_address is not valid", { param_name: "email_address" });
      next.emailAddress = email;
    }
    if (body.phone_number !== undefined && body.phone_number !== null) {
      if (!st.attributes.phoneNumber.enabled) throw new OrbitError(422, ErrorCodes.form_param_unknown, "Phone numbers are disabled for this instance", { param_name: "phone_number" });
      next.phoneNumber = normalizePhone(body.phone_number);
    }
    if (body.username !== undefined && body.username !== null) {
      if (!st.attributes.username.enabled) throw new OrbitError(422, ErrorCodes.form_param_unknown, "Usernames are disabled for this instance", { param_name: "username" });
      if (body.username !== fields.username) await assertUsernameAvailable(ctx, body.username);
      next.username = body.username;
    }
    if (body.first_name !== undefined) next.firstName = body.first_name ?? undefined;
    if (body.last_name !== undefined) next.lastName = body.last_name ?? undefined;
    if (body.external_id !== undefined) next.externalId = body.external_id ?? null;
    if (body.password !== undefined && body.password !== null && body.password !== "") {
      await assertPasswordValid(ctx, body.password);
      next.passwordHash = await hashPassword(body.password);
    }
    return next;
  };

  const validateLegal = (body: { legal_accepted?: boolean }) => {
    const st = ctx.settings.get();
    if (st.signUp.legalConsentRequired && body.legal_accepted !== true) {
      throw new OrbitError(422, ErrorCodes.form_param_missing, "You must accept the terms to sign up", { param_name: "legal_accepted" });
    }
  };

  // ───────────── create ─────────────
  app.post("/", async (c) => {
    const body = await parseBody(c, createSchema);
    const client = await getOrCreateClient(ctx, c);
    await hit(ctx, `sign_up:create:${clientIp(c)}`, 100, 60_000);
    await verifyCaptcha(ctx, captchaToken(c, body), clientIp(c));
    await abandonPrevious(client.id);
    const redirectUrl = validateRedirectUrl(ctx, body.redirect_url);
    const actionComplete = validateRedirectUrl(ctx, body.action_complete_redirect_url);
    const now = Date.now();
    const id = newId("sua");
    await ctx.db.insert(s.signUps).values({
                  id, clientId: client.id, status: "missing_requirements",
                  fields: {},
                  unsafeMetadata: body.unsafe_metadata ?? {},
                  abandonAt: now + 86_400_000, createdAt: now, updatedAt: now,
                });
    let row = await reload(id);

    if (body.strategy === "anonymous") {
      const st = ctx.settings.get();
      if (!st.anonymous.enabled) {
        throw new OrbitError(403, ErrorCodes.sign_up_restricted, "Anonymous accounts are disabled on this instance", { param_name: "strategy" });
      }
      // A waitlist or an allowlist only makes sense when a new account has an identifier to judge.
      if (st.signUp.mode !== "public") {
        throw new OrbitError(422, ErrorCodes.sign_up_restricted, "Anonymous accounts are only available when sign-ups are public", { param_name: "strategy" });
      }
      validateLegal(body);
      // Tight budget: guest accounts are cheap to mint, so one address cannot flood the instance.
      await hit(ctx, `sign_up:anonymous:${clientIp(c)}`, 10, 60 * 60_000);
      row = await saveSignUp(ctx, row, { fields: { anonymous: true, legalAcceptedAt: body.legal_accepted ? now : null } });
      // A guest session is a new login: replace the client cookie so a value planted beforehand cannot ride along.
      await completeSignUp(ctx, row, {
        ip: clientIp(c),
        userAgent: c.req.header("user-agent") ?? undefined,
        rotateClientToken: () => rotateClientTokenOnSignIn(ctx, c, client.id),
      });
      return respond(c, client.id, await reload(row.id));
    }

    if (body.strategy?.startsWith("oauth_")) {
      validateLegal(body);
      const oauthFields = await applyBodyFields({}, body);
      if (body.legal_accepted) oauthFields.legalAcceptedAt = now;
      await saveSignUp(ctx, row, { fields: oauthFields });
      const provider = providerKeyFromStrategy(body.strategy);
      if (!isProviderEnabled(ctx, provider)) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `Social provider "${provider}" is not enabled`, { param_name: "strategy" });
      const auth = await createOAuthAuthorization(ctx, c, provider, {
        clientId: client.id, kind: "sign_up", ownerId: row.id,
        redirectUrl: redirectUrl ?? ctx.settings.get().application.homeUrl,
        actionCompleteRedirectUrl: actionComplete ?? undefined,
      });
      const verifications: SignUpVerifications = {
        external_account: {
          status: "unverified", strategy: `from_oauth_${provider}`, attempts: null, expireAt: null,
          externalVerificationRedirectUrl: auth.url,
        },
      };
      await saveSignUp(ctx, row, { verifications });
      return respond(c, client.id, await reload(row.id));
    }

    if (body.transfer) {
      const signIn = await latestTransferableSignIn(ctx, client.id);
      const profile = signIn ? readTransferProfile(ctx, signIn) : null;
      if (!signIn || !profile) throw new OrbitError(400, ErrorCodes.client_state_invalid, "There is no transferable sign-in to continue");
      const fields: SignUpFields = {};
      row = await saveSignUp(ctx, row, { fields });
      const updated = await applyExternalProfile(ctx, row, profile);
      if (body.legal_accepted) await saveSignUp(ctx, updated, { fields: { ...asSignUpFields(updated), legalAcceptedAt: Date.now() } });
      await assertSignUpIdentifiers(ctx, asSignUpFields(updated));
      await clearTransferProfile(ctx, signIn);
      const completed = await maybeCompleteSignUp(ctx, await reload(row.id), { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined, rotateClientToken: () => rotateClientTokenOnSignIn(ctx, c, client.id) });
      void completed;
      return respond(c, client.id, await reload(row.id));
    }

    let invitationEmail: string | undefined;
    if (body.ticket) {
      const ticket = await redeemTicket(ctx, body.ticket);
      if (!ticket) throw new OrbitError(422, ErrorCodes.ticket_invalid, "That ticket is not valid");
      if (ticket.kind !== "invitation") throw new OrbitError(422, ErrorCodes.ticket_invalid, "This ticket can only be used to sign in");
      invitationEmail = normalizeEmail(ticket.email);
      row = await saveSignUp(ctx, row, {
              invitationId: ticket.invitationId,
              fields: { emailAddress: invitationEmail },
            });
    }

    validateLegal(body);
    const fields = await applyBodyFields(asSignUpFields(row), body);
    if (invitationEmail && fields.emailAddress !== invitationEmail) {
      throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "The email address must match the invitation", { param_name: "email_address" });
    }
    if (body.legal_accepted) fields.legalAcceptedAt = now;
    if (fields.emailAddress || fields.phoneNumber) {
      await assertSignUpIdentifiers(ctx, fields, { ticket: !!body.ticket, invitationTicket: body.ticket });
    }
    row = await saveSignUp(ctx, row, { fields });
    await maybeCompleteSignUp(ctx, await reload(row.id), { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined, rotateClientToken: () => rotateClientTokenOnSignIn(ctx, c, client.id) });
    return respond(c, client.id, await reload(row.id));
  });

  app.get("/:id", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const id = c.req.param("id");
    if (!id) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-up not found");
    return respond(c, client.id, await load(client.id, id));
  });

  app.patch("/:id", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const id = c.req.param("id");
    if (!id) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-up not found");
    const row = await load(client.id, id);
    if (row.status === "complete") throw new OrbitError(400, ErrorCodes.client_state_invalid, "This sign-up is already complete");
    const body = await parseBody(c, updateSchema);
    validateLegal({ legal_accepted: body.legal_accepted ?? (asSignUpFields(row).legalAcceptedAt ? true : undefined) });
    const fields = await applyBodyFields(asSignUpFields(row), body);
    if (body.legal_accepted) fields.legalAcceptedAt = Date.now();
    if (body.email_address || body.phone_number) {
      await assertSignUpIdentifiers(ctx, fields);
      // Changing the identifier invalidates its previous verification.
      const verifications = asSignUpVerifications(row);
      if (body.email_address) delete verifications.email_address;
      if (body.phone_number) delete verifications.phone_number;
      await saveSignUp(ctx, row, { verifications });
    }
    const updated = await saveSignUp(ctx, row, {
          fields,
          unsafeMetadata: body.unsafe_metadata ?? row.unsafeMetadata,
        });
    await maybeCompleteSignUp(ctx, await reload(updated.id), { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined, rotateClientToken: () => rotateClientTokenOnSignIn(ctx, c, client.id) });
    return respond(c, client.id, await reload(row.id));
  });

  // ───────────── verifications ─────────────
  app.post("/:id/prepare_verification", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const id = c.req.param("id");
    if (!id) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-up not found");
    const row = await load(client.id, id);
    if (row.status === "complete") throw new OrbitError(400, ErrorCodes.client_state_invalid, "This sign-up is already complete");
    const body = await parseBody(c, prepareSchema);
    await hit(ctx, `sign_up:prepare:${clientIp(c)}`, 30, 60_000);
    await verifyCaptcha(ctx, captchaToken(c, body), clientIp(c));
    const strategy = body.strategy ?? "email_code";
    if (!["email_code", "email_link", "phone_code"].includes(strategy)) {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Strategy "${strategy}" is not valid`, { param_name: "strategy" });
    }
    const fields = asSignUpFields(row);
    const verifications = asSignUpVerifications(row);
    const settings = ctx.settings.get();
    if (strategy === "phone_code") {
      if (!fields.phoneNumber) throw new OrbitError(422, ErrorCodes.form_param_missing, "Add a phone number before verifying it", { param_name: "phone_number" });
      const issued = await issueVerification(ctx, {
              purpose: "sign_up_phone", strategy: "phone_code", identifier: fields.phoneNumber, ownerId: row.id,
              lifetimeSeconds: settings.email.codeLifetimeSeconds,
            });
      await sendSms(ctx, fields.phoneNumber, `Your ${settings.application.name} verification code is ${issued.code}`);
      const snapshot: VerificationSnapshot = { verificationId: issued.row.id, status: "unverified", strategy, identifier: fields.phoneNumber };
      await saveSignUp(ctx, row, { verifications: { ...verifications, phone_number: snapshot } });
    } else {
      if (!fields.emailAddress) throw new OrbitError(422, ErrorCodes.form_param_missing, "Add an email address before verifying it", { param_name: "email_address" });
      if (strategy === "email_link") {
        const issued = await issueVerification(ctx, {
                  purpose: "sign_up_email", strategy: "email_link", identifier: fields.emailAddress, ownerId: row.id,
                  lifetimeSeconds: settings.email.linkLifetimeSeconds,
                  redirectUrl: validateRedirectUrl(ctx, body.redirect_url) ?? settings.application.homeUrl,
                });
        const link = magicLinkUrl(ctx, issued.token!, { sign_up_id: row.id });
        await sendEmail(ctx, { to: fields.emailAddress, template: "magic_link", vars: { link, expires_in_minutes: Math.round(settings.email.linkLifetimeSeconds / 60) } });
        const snapshot: VerificationSnapshot = { verificationId: issued.row.id, status: "unverified", strategy, identifier: fields.emailAddress };
        await saveSignUp(ctx, row, { verifications: { ...verifications, email_address: snapshot } });
      } else {
        const issued = await issueVerification(ctx, {
                  purpose: "sign_up_email", strategy: "email_code", identifier: fields.emailAddress, ownerId: row.id,
                  lifetimeSeconds: settings.email.codeLifetimeSeconds,
                });
        await sendEmail(ctx, {
          to: fields.emailAddress, template: "verification_code",
          vars: { code: issued.code, expires_in_minutes: Math.round(settings.email.codeLifetimeSeconds / 60) },
        });
        const snapshot: VerificationSnapshot = { verificationId: issued.row.id, status: "unverified", strategy, identifier: fields.emailAddress };
        await saveSignUp(ctx, row, { verifications: { ...verifications, email_address: snapshot } });
      }
    }
    return respond(c, client.id, await reload(row.id));
  });

  app.post("/:id/attempt_verification", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const id = c.req.param("id");
    if (!id) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-up not found");
    const row = await load(client.id, id);
    if (row.status === "complete") throw new OrbitError(400, ErrorCodes.client_state_invalid, "This sign-up is already complete");
    const body = await parseBody(c, attemptSchema);
    await hit(ctx, `sign_up:attempt:${clientIp(c)}`, 60, 60_000);
    const verifications = asSignUpVerifications(row);
    const strategy = body.strategy ?? "email_code";
    const isPhone = strategy === "phone_code";
    const snapshot = isPhone ? verifications.phone_number : verifications.email_address;
    if (!snapshot) throw new OrbitError(422, ErrorCodes.form_code_incorrect, `There is no ${isPhone ? "phone number" : "email address"} verification in progress`);
    const purpose = isPhone ? "sign_up_phone" : "sign_up_email";
    const verificationRow = await getVerification(ctx, purpose, row.id);

    if (strategy === "email_link") {
      if (!verificationRow || !(verificationRow.verifiedAt || verificationRow.consumedAt)) {
        // Polling from the device that did not open the link.
        return respond(c, client.id, await reload(row.id));
      }
    } else {
      await checkCode(ctx, verificationRow, body.code);
    }
    const next: SignUpVerifications = {
      ...verifications,
      [isPhone ? "phone_number" : "email_address"]: { ...snapshot, status: "verified", strategy: isPhone ? "phone_code" : snapshot.strategy },
    };
    await saveSignUp(ctx, row, { verifications: next });
    await maybeCompleteSignUp(ctx, await reload(row.id), { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined, rotateClientToken: () => rotateClientTokenOnSignIn(ctx, c, client.id) });
    const finalRow = await reload(row.id);
    const response = await buildSignUpJSON(ctx, finalRow);
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response, client: clientJson });
  });

  return app;
}
