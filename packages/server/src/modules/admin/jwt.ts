// Backend API JWT templates (`/v1/jwt_templates`).
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { generateKeyPair, exportJWK } from "jose";
import { ErrorCodes, ID_PREFIX, OrbitError, type JwtTemplateJSON } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import { decrypt, encrypt, randomToken } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import * as s from "../../db/schema";
import { audit } from "../../services/audit";
import type { AppContext } from "../../context";
import { bool, deleted, listParams, metadataSchema, page } from "./shared";
import { first } from "../../lib/db";

/** Claims owned by the session token machinery; templates must not be able to override them. */
const RESERVED_CLAIMS = ["iss", "sub", "exp", "iat", "nbf", "jti", "azp", "sid", "act", "sts", "fva", "org_id", "org_slug", "org_role", "org_permissions"];
const SIGNING_ALGORITHMS = ["RS256", "ES256", "HS256"] as const;

function assertAllowedClaims(claims: Record<string, unknown>): void {
  for (const key of Object.keys(claims)) {
    if (RESERVED_CLAIMS.includes(key)) {
      throw new OrbitError(422, ErrorCodes.form_param_value_invalid, `"${key}" is a reserved claim and cannot be set in a template.`, { param_name: `claims.${key}` });
    }
  }
}

/** Encrypts a freshly generated private key: a JWK (RS256/ES256) or an HMAC secret (HS256). */
async function generateSigningKey(ctx: AppContext, algorithm: (typeof SIGNING_ALGORITHMS)[number]): Promise<string> {
  if (algorithm === "HS256") return encrypt(ctx.env.encryptionKey, randomToken(48));
  const { privateKey } = await generateKeyPair(algorithm, { extractable: true });
  return encrypt(ctx.env.encryptionKey, JSON.stringify(await exportJWK(privateKey)));
}

/** What a verifier needs: the HMAC secret (HS256) or the public half of the JWK (RS256/ES256). Backend API only. */
function verificationKey(ctx: AppContext, row: typeof s.jwtTemplates.$inferSelect): JwtTemplateJSON["signing_key"] {
  if (!row.customSigningKey || !row.signingKeyEnc) return undefined;
  const plain = decrypt(ctx.env.encryptionKey, row.signingKeyEnc);
  if (row.signingAlgorithm === "HS256") return plain;
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicJwk } = JSON.parse(plain);
  return publicJwk;
}

function serializeTemplate(ctx: AppContext, row: typeof s.jwtTemplates.$inferSelect): JwtTemplateJSON {
  return {
    object: "jwt_template",
    id: row.id,
    name: row.name,
    claims: row.claims ?? {},
    lifetime: row.lifetime,
    allowed_clock_skew: row.allowedClockSkew,
    custom_signing_key: row.customSigningKey,
    signing_algorithm: row.signingAlgorithm,
    signing_key: verificationKey(ctx, row),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

const createSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "may only contain letters, digits, '-' and '_'"),
  claims: metadataSchema.default({}),
  lifetime: z.coerce.number().int().min(30).max(315_360_000).default(60),
  allowed_clock_skew: z.coerce.number().int().min(0).max(300).default(5),
  custom_signing_key: bool.default(false),
  signing_algorithm: z.enum(SIGNING_ALGORITHMS).default("RS256"),
});

const updateSchema = createSchema.partial();

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/jwt_templates", async (c) => {
    const { limit, offset } = listParams(c);
    const rows = (await ctx.db.select().from(s.jwtTemplates).orderBy(s.jwtTemplates.createdAt).limit(limit).offset(offset));
    const total = Number(first(await ctx.db.select({ n: sql<number>`count(*)` }).from(s.jwtTemplates))?.n ?? 0);
    return c.json(page(rows.map((row) => serializeTemplate(ctx, row)), total));
  });

  app.get("/jwt_templates/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.id, c.req.param("id"))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "JWT template not found.");
    return c.json(serializeTemplate(ctx, row));
  });

  app.post("/jwt_templates", async (c) => {
    const body = await parseBody(c, createSchema);
    assertAllowedClaims(body.claims);
    if (first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.name, body.name)))) {
      throw new OrbitError(422, ErrorCodes.duplicate_record, "A JWT template with this name already exists.", { param_name: "name" });
    }
    const now = Date.now();
    const row = first(await ctx.db
          .insert(s.jwtTemplates)
          .values({
            id: newId(ID_PREFIX.jwtTemplate),
            name: body.name,
            claims: body.claims,
            lifetime: body.lifetime,
            allowedClockSkew: body.allowed_clock_skew,
            customSigningKey: body.custom_signing_key,
            signingAlgorithm: body.signing_algorithm,
            signingKeyEnc: body.custom_signing_key ? await generateSigningKey(ctx, body.signing_algorithm) : null,
            createdAt: now,
            updatedAt: now,
          })
          .returning())!;
    await audit(ctx, { actor: "secret_key", action: "jwt_template.created", targetType: "jwt_template", targetId: row.id, metadata: { name: row.name } });
    return c.json(serializeTemplate(ctx, row));
  });

  app.patch("/jwt_templates/:id", async (c) => {
    const existing = first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.id, c.req.param("id"))));
    if (!existing) throw new OrbitError(404, ErrorCodes.resource_not_found, "JWT template not found.");
    const body = await parseBody(c, updateSchema);
    if (body.claims) assertAllowedClaims(body.claims);
    if (body.name && body.name !== existing.name) {
      const taken = first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.name, body.name)));
      if (taken) throw new OrbitError(422, ErrorCodes.duplicate_record, "A JWT template with this name already exists.", { param_name: "name" });
    }
    const patch: Partial<typeof s.jwtTemplates.$inferInsert> = { updatedAt: Date.now() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.claims !== undefined) patch.claims = body.claims;
    if (body.lifetime !== undefined) patch.lifetime = body.lifetime;
    if (body.allowed_clock_skew !== undefined) patch.allowedClockSkew = body.allowed_clock_skew;
    if (body.signing_algorithm !== undefined) patch.signingAlgorithm = body.signing_algorithm;
    if (body.custom_signing_key !== undefined) patch.customSigningKey = body.custom_signing_key;

    // (Re)generate the key when custom signing was turned on or the algorithm changed under a custom key.
    const algorithm = body.signing_algorithm ?? (existing.signingAlgorithm as (typeof SIGNING_ALGORITHMS)[number]);
    const customKey = body.custom_signing_key ?? existing.customSigningKey;
    const needsKey = customKey && (!existing.signingKeyEnc || body.signing_algorithm !== undefined);
    if (needsKey) patch.signingKeyEnc = await generateSigningKey(ctx, algorithm);
    if (!customKey) patch.signingKeyEnc = null;

    await ctx.db.update(s.jwtTemplates).set(patch).where(eq(s.jwtTemplates.id, existing.id));
    const updated = first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.id, existing.id)))!;
    await audit(ctx, { actor: "secret_key", action: "jwt_template.updated", targetType: "jwt_template", targetId: updated.id, metadata: { name: updated.name } });
    return c.json(serializeTemplate(ctx, updated));
  });

  app.delete("/jwt_templates/:id", async (c) => {
    const existing = first(await ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.id, c.req.param("id"))));
    if (!existing) throw new OrbitError(404, ErrorCodes.resource_not_found, "JWT template not found.");
    await ctx.db.delete(s.jwtTemplates).where(eq(s.jwtTemplates.id, existing.id));
    await audit(ctx, { actor: "secret_key", action: "jwt_template.deleted", targetType: "jwt_template", targetId: existing.id, metadata: { name: existing.name } });
    return c.json(deleted("jwt_template", existing.id));
  });

  return app;
}
