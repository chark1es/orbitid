// enterprise connection validation/serialization (shared by the backend CRUD routes).
import { z } from "zod";
import { eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import {
  assertValidCertificate, assertValidDomains, DEFAULT_ATTRIBUTE_MAPPING, encryptClientSecret, normalizeDomains,
} from "../../services/saml";
import { assertPublicUrl } from "../../lib/safe-fetch";
import { first } from "../../lib/db";

type ConnectionRow = typeof s.enterpriseConnections.$inferSelect;

const attributeMappingSchema = z.record(z.string(), z.string().min(1));

export const connectionBodySchema = z.object({
  name: z.string().min(1).max(256),
  protocol: z.enum(["saml", "oidc"]).default("saml"),
  provider: z.string().min(1).max(64).default("custom"),
  domains: z.array(z.string().min(1)).max(50).default([]),
  active: z.boolean().default(false),
  allow_subdomains: z.boolean().default(false),
  allow_idp_initiated: z.boolean().default(false),
  sync_user_attributes: z.boolean().default(true),
  disable_additional_identifications: z.boolean().default(false),
  idp_entity_id: z.string().min(1).optional(),
  idp_sso_url: z.string().url().optional(),
  idp_certificate: z.string().min(1).optional(),
  attribute_mapping: attributeMappingSchema.optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  discovery_url: z.string().url().optional(),
});

export const connectionPatchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  provider: z.string().min(1).max(64).optional(),
  domains: z.array(z.string().min(1)).max(50).optional(),
  active: z.boolean().optional(),
  allow_subdomains: z.boolean().optional(),
  allow_idp_initiated: z.boolean().optional(),
  sync_user_attributes: z.boolean().optional(),
  disable_additional_identifications: z.boolean().optional(),
  idp_entity_id: z.string().min(1).optional(),
  idp_sso_url: z.string().url().optional(),
  idp_certificate: z.string().min(1).optional(),
  attribute_mapping: attributeMappingSchema.optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  discovery_url: z.string().url().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

type ConnectionBody = z.infer<typeof connectionBodySchema>;

function requireField(value: string | undefined, param: string, protocol: string): string {
  if (!value) throw new OrbitError(422, ErrorCodes.form_param_missing, `${param} is required for ${protocol} connections`, { param_name: param });
  return value;
}

function samlConfigFromBody(body: ConnectionBody) {
  return {
    idpEntityId: requireField(body.idp_entity_id, "idp_entity_id", "SAML"),
    idpSsoUrl: requireField(body.idp_sso_url, "idp_sso_url", "SAML"),
    idpCertificate: assertValidCertificate(requireField(body.idp_certificate, "idp_certificate", "SAML")),
    attributeMapping: { ...DEFAULT_ATTRIBUTE_MAPPING, ...(body.attribute_mapping ?? {}) },
  };
}

/**
 * One domain, one connection. If two connections claimed the same domain, sign-in routing and the assertion could land
 * on different connections, so a second tenant could capture another's users. A connection that allows subdomains also
 * claims everything beneath its domains.
 */
async function assertDomainsUnclaimed(ctx: AppContext, domains: string[], allowSubdomains: boolean, exceptId?: string): Promise<void> {
  if (!domains.length) return;
  const others = (await ctx.db.select().from(s.enterpriseConnections)).filter((row) => row.id !== exceptId);
  const under = (child: string, parent: string) => child === parent || child.endsWith(`.${parent}`);
  for (const domain of domains) {
    for (const other of others) {
      for (const taken of other.domains ?? []) {
        const clash = domain === taken
          || (other.allowSubdomains && under(domain, taken))
          || (allowSubdomains && under(taken, domain));
        if (clash) throw new OrbitError(409, ErrorCodes.duplicate_record, `The domain ${domain} already belongs to another connection`, { param_name: "domains" });
      }
    }
  }
}

export async function createConnection(ctx: AppContext, body: ConnectionBody): Promise<ConnectionRow> {
  const domains = normalizeDomains(body.domains);
  assertValidDomains(domains);
  await assertDomainsUnclaimed(ctx, domains, body.allow_subdomains);
  if (body.protocol === "saml" && body.idp_sso_url) await assertPublicUrl(ctx, body.idp_sso_url, "idp_sso_url");
  if (body.discovery_url) await assertPublicUrl(ctx, body.discovery_url, "discovery_url");
  const now = Date.now();
  const config = body.protocol === "saml"
    ? samlConfigFromBody(body)
    : {
        clientId: requireField(body.client_id, "client_id", "OIDC"),
        clientSecretEnc: encryptClientSecret(ctx, requireField(body.client_secret, "client_secret", "OIDC")),
        discoveryUrl: requireField(body.discovery_url, "discovery_url", "OIDC"),
      };
  const row: ConnectionRow = {
    id: newId(ID_PREFIX.enterprise),
    name: body.name,
    protocol: body.protocol,
    provider: body.provider,
    domains,
    active: body.active,
    allowSubdomains: body.allow_subdomains,
    allowIdpInitiated: body.allow_idp_initiated,
    syncUserAttributes: body.sync_user_attributes,
    disableAdditionalIdentifications: body.disable_additional_identifications,
    config,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.db.insert(s.enterpriseConnections).values(row);
  return row;
}

/** Applies a partial update. Protocol is immutable, SAML keeps its attribute mapping merged with defaults. */
export async function updateConnection(ctx: AppContext, row: ConnectionRow, patch: z.infer<typeof connectionPatchSchema>): Promise<ConnectionRow> {
  const set: Partial<ConnectionRow> = { updatedAt: Date.now() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.allow_subdomains !== undefined) set.allowSubdomains = patch.allow_subdomains;
  if (patch.allow_idp_initiated !== undefined) set.allowIdpInitiated = patch.allow_idp_initiated;
  if (patch.sync_user_attributes !== undefined) set.syncUserAttributes = patch.sync_user_attributes;
  if (patch.disable_additional_identifications !== undefined) set.disableAdditionalIdentifications = patch.disable_additional_identifications;
  if (patch.domains !== undefined) {
    const domains = normalizeDomains(patch.domains);
    assertValidDomains(domains);
    set.domains = domains;
  }
  if (patch.domains !== undefined || patch.allow_subdomains !== undefined) {
    await assertDomainsUnclaimed(ctx, set.domains ?? row.domains ?? [], set.allowSubdomains ?? row.allowSubdomains, row.id);
  }

  const config = { ...(row.config ?? {}) } as Record<string, unknown>;
  if (row.protocol === "saml") {
    if (patch.idp_entity_id !== undefined) config.idpEntityId = patch.idp_entity_id;
    if (patch.idp_sso_url !== undefined) {
      await assertPublicUrl(ctx, patch.idp_sso_url, "idp_sso_url");
      config.idpSsoUrl = patch.idp_sso_url;
    }
    if (patch.idp_certificate !== undefined) config.idpCertificate = assertValidCertificate(patch.idp_certificate);
    if (patch.attribute_mapping !== undefined) {
      const current = (config.attributeMapping as Record<string, string> | undefined) ?? {};
      config.attributeMapping = { ...DEFAULT_ATTRIBUTE_MAPPING, ...current, ...patch.attribute_mapping };
    }
  } else {
    if (patch.client_id !== undefined) config.clientId = patch.client_id;
    if (patch.client_secret !== undefined) config.clientSecretEnc = encryptClientSecret(ctx, patch.client_secret);
    if (patch.discovery_url !== undefined) {
      await assertPublicUrl(ctx, patch.discovery_url, "discovery_url");
      config.discoveryUrl = patch.discovery_url;
      delete config.discovery; // re-resolve lazily against the new issuer
    }
  }
  set.config = config as ConnectionRow["config"];
  await ctx.db.update(s.enterpriseConnections).set(set).where(eq(s.enterpriseConnections.id, row.id));
  return first(await ctx.db.select().from(s.enterpriseConnections).where(eq(s.enterpriseConnections.id, row.id)))!;
}
