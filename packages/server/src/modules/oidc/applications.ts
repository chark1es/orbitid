/** OAuth application management routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { parseBody, parsePagination } from "../../lib/http";
import { requireSecretKey } from "../../middleware";
import { createApplication, deleteApplication, listApplications, requireApplication, rotateClientSecret, serializeApplication, updateApplication } from "../../services/oidc";
import { applicationSchema, applicationPatchSchema } from "./shared";

export function registerApplicationRoutes(app: Hono, ctx: AppContext) {
  // ─────────── management API (secret key) ───────────
  const guard = requireSecretKey(ctx);
  app.use("/v1/oauth_applications", guard);
  app.use("/v1/oauth_applications/*", guard);

  app.post("/v1/oauth_applications", async (c) => {
    const body = await parseBody(c, applicationSchema);
    const { row, clientSecret } = await createApplication(ctx, {
      name: body.name,
      redirectUris: body.redirect_uris,
      postLogoutRedirectUris: body.post_logout_redirect_uris,
      scopes: body.scopes,
      isPublic: body.public,
      consentScreenEnabled: body.consent_screen_enabled,
      pkceRequired: body.pkce_required,
      accessTokenLifetimeSeconds: body.access_token_lifetime_seconds,
      refreshTokenLifetimeSeconds: body.refresh_token_lifetime_seconds,
      idTokenLifetimeSeconds: body.id_token_lifetime_seconds,
      groupsClaim: body.groups_claim,
    });
    return c.json(serializeApplication(row, { clientSecret }), 201);
  });

  app.get("/v1/oauth_applications", async (c) => {
    const page = parsePagination(c);
    const { data, totalCount } = await listApplications(ctx, { limit: page.limit, offset: page.offset });
    return c.json({ data: data.map((r) => serializeApplication(r)), total_count: totalCount });
  });

  app.get("/v1/oauth_applications/:id", async (c) => c.json(serializeApplication(await requireApplication(ctx, c.req.param("id")))));

  app.patch("/v1/oauth_applications/:id", async (c) => {
    const row = await requireApplication(ctx, c.req.param("id"));
    const body = await parseBody(c, applicationPatchSchema);
    return c.json(serializeApplication(await updateApplication(ctx, row, {
      name: body.name,
      redirectUris: body.redirect_uris,
      postLogoutRedirectUris: body.post_logout_redirect_uris,
      scopes: body.scopes,
      consentScreenEnabled: body.consent_screen_enabled,
      pkceRequired: body.pkce_required,
      accessTokenLifetimeSeconds: body.access_token_lifetime_seconds,
      refreshTokenLifetimeSeconds: body.refresh_token_lifetime_seconds,
      idTokenLifetimeSeconds: body.id_token_lifetime_seconds,
      groupsClaim: body.groups_claim,
    })));
  });

  app.delete("/v1/oauth_applications/:id", async (c) => {
    const row = await requireApplication(ctx, c.req.param("id"));
    await deleteApplication(ctx, row);
    return c.json({ object: "oauth_application", id: row.id, deleted: true });
  });

  app.post("/v1/oauth_applications/:id/rotate_secret", async (c) => {
    const row = await requireApplication(ctx, c.req.param("id"));
    const { row: updated, clientSecret } = await rotateClientSecret(ctx, row);
    return c.json(serializeApplication(updated, { clientSecret }));
  });

  return app;
}
