// API keys: Backend API `/v1/api_keys` + Frontend API self-service for users and organizations.
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError, type ApiKeyJSON } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { parseBody, parsePagination } from "../lib/http";
import { z } from "zod";
import {
  assertApiKeyOwnership, assertOrgApiKeysPermission, createApiKey, deleteApiKey, listApiKeys, requireApiKey,
  revokeApiKey, serializeApiKey, updateApiKey, verifyApiKey,
} from "../services/api-keys";
import { requireUserCaller } from "./machine/auth";
import { first } from "../lib/db";

const scopesSchema = z.array(z.string().min(1)).max(100);
const claimsSchema = z.record(z.string(), z.unknown());
const secondsUntilExpiration = z.number().int().positive().nullable().optional();

const createSchema = z.object({
  name: z.string().min(1).max(256),
  subject: z.string().min(1),
  scopes: scopesSchema.optional(),
  claims: claimsSchema.nullable().optional(),
  seconds_until_expiration: secondsUntilExpiration,
  description: z.string().max(1024).nullable().optional(),
  created_by: z.string().nullable().optional(),
});
const patchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).nullable().optional(),
  scopes: scopesSchema.optional(),
  claims: claimsSchema.nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

/** Frontend API create payload: the subject is derived from the route, never from the body. */
const fapiCreateSchema = z.object({
  name: z.string().min(1).max(256),
  scopes: scopesSchema.optional(),
  claims: claimsSchema.nullable().optional(),
  seconds_until_expiration: secondsUntilExpiration,
  description: z.string().max(1024).nullable().optional(),
});
const revokeSchema = z.object({ revocation_reason: z.string().max(1024).nullable().optional() });

const response = <T>(c: Context, value: T) => c.json({ response: value });
const listResponse = (c: Context, data: ApiKeyJSON[]) => c.json({ response: data });

export default function routes(ctx: AppContext): { fapi?: Hono; backend?: Hono; saml?: Hono } {
  return { fapi: frontendRoutes(ctx), backend: backendRoutes(ctx) };
}

function backendRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/api_keys", async (c) => {
    const body = await parseBody(c, createSchema);
    const { row, secret } = await createApiKey(ctx, {
          name: body.name,
          subject: body.subject,
          scopes: body.scopes,
          claims: body.claims ?? null,
          secondsUntilExpiration: body.seconds_until_expiration ?? null,
          description: body.description ?? null,
          createdBy: body.created_by ?? null,
        });
    return c.json(serializeApiKey(row, { secret }), 201);
  });

  app.post("/api_keys/verify", async (c) => {
    const body = await parseBody(c, z.object({ secret: z.string().min(1) }));
    return c.json(serializeApiKey(await verifyApiKey(ctx, body.secret)));
  });

  app.get("/api_keys", async (c) => {
    const page = parsePagination(c);
    const subject = c.req.query("subject") || undefined;
    const includeInvalid = ["true", "1"].includes(c.req.query("include_invalid") ?? "");
    const { data, totalCount } = await listApiKeys(ctx, { subject, includeInvalid, limit: page.limit, offset: page.offset, orderBy: page.order_by });
    return c.json({ data: data.map((r) => serializeApiKey(r)), total_count: totalCount });
  });

  app.get("/api_keys/:id", async (c) => c.json(serializeApiKey(await requireApiKey(ctx, c.req.param("id")))));

  app.patch("/api_keys/:id", async (c) => {
    const row = await requireApiKey(ctx, c.req.param("id"));
    const body = await parseBody(c, patchSchema);
    return c.json(serializeApiKey(await updateApiKey(ctx, row, body)));
  });

  app.post("/api_keys/:id/revoke", async (c) => {
    const row = await requireApiKey(ctx, c.req.param("id"));
    const body = await parseBody(c, revokeSchema);
    return c.json(serializeApiKey(await revokeApiKey(ctx, row, body.revocation_reason ?? null)));
  });

  app.delete("/api_keys/:id", async (c) => {
    const row = await requireApiKey(ctx, c.req.param("id"));
    await deleteApiKey(ctx, row);
    return c.json({ object: "api_key", id: row.id, deleted: true });
  });

  return app;
}

/**
 * Frontend API routes, mounted at `/v1/client`:
 *   /me/api_keys…                            — the signed-in user's own keys
 *   /organizations/:orgId/api_keys…          — org keys, gated by the org API-key permission
 */
function frontendRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  const userSubject = async (c: Context) => {
    const caller = await requireUserCaller(ctx, c);
    const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, caller.userId)));
    return { subject: caller.userId, actorId: caller.userId, anonymous: !!user?.isAnonymous };
  };
  const orgSubject = async (c: Context) => {
    const caller = await requireUserCaller(ctx, c);
    const orgId = c.req.param("orgId")!;
    const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, orgId)));
    if (!org) throw new OrbitError(404, ErrorCodes.organization_not_found, "Organization not found");
    await assertOrgApiKeysPermission(ctx, caller.userId, orgId);
    return { subject: orgId, actorId: caller.userId, anonymous: false };
  };

  const register = (base: string, subjectOf: (c: Context) => Promise<{ subject: string; actorId: string; anonymous: boolean }>) => {
    app.get(base, async (c) => {
      const { subject } = await subjectOf(c);
      const page = parsePagination(c);
      const includeInvalid = ["true", "1"].includes(c.req.query("include_invalid") ?? "");
      const { data } = await listApiKeys(ctx, { subject, includeInvalid, limit: page.limit, offset: page.offset, orderBy: page.order_by });
      return listResponse(c, data.map((r) => serializeApiKey(r)));
    });

    app.post(base, async (c) => {
      const { subject, actorId, anonymous } = await subjectOf(c);
      // A guest account must attach an identifier before it can own machine credentials.
      if (anonymous) throw new OrbitError(403, ErrorCodes.not_allowed_access, "Anonymous accounts cannot create API keys. Add an email address or password first.");
      const body = await parseBody(c, fapiCreateSchema);
      const { row, secret } = await createApiKey(ctx, {
              name: body.name,
              subject,
              scopes: body.scopes,
              claims: body.claims ?? null,
              secondsUntilExpiration: body.seconds_until_expiration ?? null,
              description: body.description ?? null,
              createdBy: actorId,
            });
      return c.json({ response: serializeApiKey(row, { secret }) }, 201);
    });

    app.get(`${base}/:id`, async (c) => {
      const { subject } = await subjectOf(c);
      const row = await requireApiKey(ctx, c.req.param("id"));
      assertApiKeyOwnership(row, subject);
      return response(c, serializeApiKey(row));
    });

    app.patch(`${base}/:id`, async (c) => {
      const { subject } = await subjectOf(c);
      const row = await requireApiKey(ctx, c.req.param("id"));
      assertApiKeyOwnership(row, subject);
      const body = await parseBody(c, patchSchema);
      return response(c, serializeApiKey(await updateApiKey(ctx, row, body)));
    });

    app.post(`${base}/:id/revoke`, async (c) => {
      const { subject } = await subjectOf(c);
      const row = await requireApiKey(ctx, c.req.param("id"));
      assertApiKeyOwnership(row, subject);
      const body = await parseBody(c, revokeSchema);
      return response(c, serializeApiKey(await revokeApiKey(ctx, row, body.revocation_reason ?? null)));
    });

    app.delete(`${base}/:id`, async (c) => {
      const { subject } = await subjectOf(c);
      const row = await requireApiKey(ctx, c.req.param("id"));
      assertApiKeyOwnership(row, subject);
      await deleteApiKey(ctx, row);
      return response(c, { object: "api_key", id: row.id, deleted: true });
    });
  };

  register("/me/api_keys", userSubject);
  register("/organizations/:orgId/api_keys", orgSubject);
  return app;
}
