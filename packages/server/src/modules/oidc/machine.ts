/** Machine-token (client_credentials) routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { parseBody } from "../../lib/http";
import { OAuthError, parseBasicAuthorization } from "../../services/oidc";
import { authenticateMachineSecret, issueMachineToken, serializeMachineToken } from "../../services/m2m";
import { handle } from "./shared";

export function registerMachineRoutes(app: Hono, ctx: AppContext) {
  // ─────────── machine tokens (client_credentials, machine secret) ───────────
  // app.ts denies non-secret-key callers on /v1/m2m, so machines mint tokens here.
  app.post("/oauth/m2m/token", handle(async (c) => {
    const body = await parseBody(c, z.object({
      grant_type: z.string().optional(),
      machine_id: z.string().optional(),
      machine_secret: z.string().optional(),
      seconds_until_expiration: z.coerce.number().int().positive().optional(),
      claims: z.union([z.record(z.string(), z.unknown()), z.string()]).nullable().optional(),
      token_format: z.enum(["opaque", "jwt"]).optional(),
    }));
    if (body.grant_type && body.grant_type !== "client_credentials") {
      throw new OAuthError(400, "unsupported_grant_type", "Only client_credentials is supported");
    }
    const basic = parseBasicAuthorization(c.req.header("authorization"));
    const machineId = basic?.clientId ?? body.machine_id;
    const machineSecret = basic?.clientSecret ?? body.machine_secret;
    if (!machineId || !machineSecret) throw new OAuthError(401, "invalid_client", "machine_id and machine_secret are required");
    const machine = await authenticateMachineSecret(ctx, machineSecret);
    if (!machine || machine.id !== machineId) throw new OAuthError(401, "invalid_client", "Machine authentication failed");
    let claims: Record<string, unknown> | null = null;
    if (typeof body.claims === "string") {
      try {
        claims = JSON.parse(body.claims) as Record<string, unknown>;
      } catch {
        throw new OAuthError(400, "invalid_request", "claims must be a JSON object");
      }
    } else if (body.claims) {
      claims = body.claims;
    }
    const { row, token } = await issueMachineToken(ctx, machine, {
      secondsUntilExpiration: body.seconds_until_expiration ?? null,
      claims,
      tokenFormat: body.token_format ?? "opaque",
    });
    return c.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.round(((row.expiresAt ?? Date.now()) - Date.now()) / 1000)),
      token_format: body.token_format ?? "opaque",
      machine_token: serializeMachineToken(row),
      scope: (machine.scopedMachines ?? []).join(" "),
    });
  }));
}
