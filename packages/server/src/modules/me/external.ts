/** External (social) account routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { decrypt } from "../../lib/crypto";
import { parseBody } from "../../lib/http";
import { serializeExternalAccount } from "../../serializers";
import { assertNotLastIdentification } from "../../services/users";
import { getOAuthAdapter, isProviderEnabled, providerKeyFromStrategy } from "../../services/oauth-providers";
import { requireReverification } from "../auth/reverification";
import { createOAuthAuthorization } from "../auth/oauth-flow";
import { validateRedirectUrl } from "../auth/redirects";
import { first } from "../../lib/db";
import { externalAccountCreateSchema } from "./shared";
import type { MeHelpers } from "./helpers";

export function registerExternalAccountRoutes(app: Hono, ctx: AppContext, helpers: MeHelpers) {
  const { auth, emitUserUpdated } = helpers;

  // ───────────── external accounts ─────────────
  app.get("/external_accounts", async (c) => {
    const { user } = await auth(c);
    const rows = (await ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.userId, user.id)));
    return c.json({ response: rows.map(serializeExternalAccount) });
  });

  app.post("/external_accounts", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { client, user } = await auth(c);
    const body = await parseBody(c, externalAccountCreateSchema);
    if (!body.strategy.startsWith("oauth_")) throw new OrbitError(422, ErrorCodes.oauth_provider_not_enabled, "strategy must be an oauth_* strategy", { param_name: "strategy" });
    const provider = providerKeyFromStrategy(body.strategy);
    if (!isProviderEnabled(ctx, provider)) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `Social provider "${provider}" is not enabled`, { param_name: "strategy" });
    const adapter = await getOAuthAdapter(ctx, provider);
    if (!adapter) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "Unsupported provider", { param_name: "strategy" });
    const redirectUrl = validateRedirectUrl(ctx, body.redirect_url) ?? ctx.settings.get().application.homeUrl;
    const authStart = await createOAuthAuthorization(ctx, c, provider, {
      clientId: client.id, kind: "connect", userId: user.id, redirectUrl,
      additionalScopes: body.additional_scopes,
    });
    return c.json({
      response: {
        object: "external_account",
        id: authStart.state,
        provider,
        provider_user_id: "",
        identification_id: authStart.state,
        email_address: "",
        first_name: "",
        last_name: "",
        username: null,
        image_url: null,
        avatar_url: null,
        approved_scopes: "",
        public_metadata: {},
        label: null,
        verification: { status: "unverified", strategy: `oauth_${provider}`, attempts: null, expire_at: null, external_verification_redirect_url: authStart.url },
        external_verification_redirect_url: authStart.url,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    });
  });

  app.delete("/external_accounts/:id", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.externalAccounts).where(and(eq(s.externalAccounts.id, id), eq(s.externalAccounts.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.external_account_not_found, "External account not found");
    await assertNotLastIdentification(ctx, user.id);
    await ctx.db.delete(s.externalAccounts).where(eq(s.externalAccounts.id, id));
    await emitUserUpdated(user.id);
    return c.json({ response: { object: "external_account", id, deleted: true } });
  });

  app.get("/external_accounts/:id/access_token", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.externalAccounts).where(and(eq(s.externalAccounts.id, id), eq(s.externalAccounts.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.external_account_not_found, "External account not found");
    const token = row.accessTokenEnc ? decrypt(ctx.env.encryptionKey, row.accessTokenEnc) : null;
    return c.json({
      response: {
        object: "external_account_access_token",
        token,
        expires_at: row.tokenExpiresAt,
        scopes: row.approvedScopes,
      },
    });
  });
}
