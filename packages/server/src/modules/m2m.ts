// `/v1/m2m/*` (backend secret-key guarded) plus machine-secret token minting.
//
// `app.ts` guards `/v1/m2m` with `requireSecretKey`, so a bare machine secret cannot mint tokens here.
// The client_credentials-style entry point for machine secrets lives at `POST /oauth/m2m/token`
// (registered by modules/oidc.ts) and delegates to `issueMachineToken` below.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import { parseBody, parsePagination } from "../lib/http";
import {
  addMachineScope, authenticateMachineSecret, createMachine, deleteMachine, issueMachineToken, listMachines,
  listMachineTokens, requireMachine, requireMachineToken, revokeMachineToken, rotateMachineSecret,
  serializeMachine, serializeMachineToken, updateMachine, verifyMachineToken,
} from "../services/m2m";

const scopedMachinesSchema = z.array(z.string().min(1)).max(100);

const createMachineSchema = z.object({
  name: z.string().min(1).max(256),
  scoped_machines: scopedMachinesSchema.optional(),
  default_token_ttl: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
});

const patchMachineSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  scoped_machines: scopedMachinesSchema.optional(),
  default_token_ttl: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

const issueTokenSchema = z.object({
  machine_id: z.string().min(1).optional(),
  machine_secret: z.string().min(1).optional(),
  seconds_until_expiration: z.coerce.number().int().positive().optional(),
  claims: z.record(z.string(), z.unknown()).nullable().optional(),
  token_format: z.enum(["opaque", "jwt"]).default("opaque"),
});

const addScopeSchema = z.object({
  machine_id: z.string().min(1).optional(),
  scoped_machine_id: z.string().min(1).optional(),
}).refine((v) => !!(v.machine_id ?? v.scoped_machine_id), { message: "scoped_machine_id is required" });

const bearerToken = (c: Context) => (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

/**
 * Resolves the machine that may mint a token: a `mk_...` Bearer secret wins, otherwise
 * `machine_id` (+ optional `machine_secret`) from the body. The secret-key gate already ran in app.ts.
 */
export async function resolveTokenMachine(ctx: AppContext, c: Context, body: { machine_id?: string; machine_secret?: string }) {
  const bearer = bearerToken(c);
  if (bearer.startsWith("mk_")) {
    const machine = authenticateMachineSecret(ctx, bearer);
    if (!machine) throw new OrbitError(401, ErrorCodes.authorization_invalid, "Invalid machine secret");
    if (body.machine_id && body.machine_id !== machine.id) throw new OrbitError(401, ErrorCodes.authorization_invalid, "Machine secret does not match machine_id");
    return machine;
  }
  if (body.machine_secret) {
    const machine = authenticateMachineSecret(ctx, body.machine_secret);
    if (!machine) throw new OrbitError(401, ErrorCodes.authorization_invalid, "Invalid machine secret");
    if (body.machine_id && body.machine_id !== machine.id) throw new OrbitError(401, ErrorCodes.authorization_invalid, "Machine secret does not match machine_id");
    return machine;
  }
  if (!body.machine_id) throw new OrbitError(422, ErrorCodes.form_param_missing, "machine_id is missing", { param_name: "machine_id" });
  return requireMachine(ctx, body.machine_id);
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.post("/machines", async (c) => {
    const body = await parseBody(c, createMachineSchema);
    const { row, secret } = createMachine(ctx, { name: body.name, scopedMachines: body.scoped_machines, defaultTokenTtl: body.default_token_ttl });
    return c.json({ ...serializeMachine(row), secret }, 201);
  });

  app.get("/machines", (c) => {
    const page = parsePagination(c);
    const { data, totalCount } = listMachines(ctx, { limit: page.limit, offset: page.offset });
    return c.json({ data: data.map(serializeMachine), total_count: totalCount });
  });

  app.get("/machines/:id", (c) => c.json(serializeMachine(requireMachine(ctx, c.req.param("id")))));

  app.patch("/machines/:id", async (c) => {
    const row = requireMachine(ctx, c.req.param("id"));
    const body = await parseBody(c, patchMachineSchema);
    return c.json(serializeMachine(updateMachine(ctx, row, { name: body.name, scopedMachines: body.scoped_machines, defaultTokenTtl: body.default_token_ttl })));
  });

  app.delete("/machines/:id", (c) => {
    const row = requireMachine(ctx, c.req.param("id"));
    deleteMachine(ctx, row);
    return c.json({ object: "machine", id: row.id, deleted: true });
  });

  app.post("/machines/:id/secret/rotate", (c) => {
    const row = requireMachine(ctx, c.req.param("id"));
    const { row: updated, secret } = rotateMachineSecret(ctx, row);
    return c.json({ ...serializeMachine(updated), secret });
  });

  app.post("/machines/:id/scopes", async (c) => {
    const row = requireMachine(ctx, c.req.param("id"));
    const body = await parseBody(c, addScopeSchema);
    const scopedId = body.scoped_machine_id ?? body.machine_id!;
    return c.json(serializeMachine(addMachineScope(ctx, row, scopedId)));
  });

  app.post("/tokens", async (c) => {
    const body = await parseBody(c, issueTokenSchema);
    const machine = await resolveTokenMachine(ctx, c, body);
    const { row, token } = await issueMachineToken(ctx, machine, {
      secondsUntilExpiration: body.seconds_until_expiration ?? null,
      claims: body.claims ?? null,
      tokenFormat: body.token_format,
    });
    return c.json(serializeMachineToken(row, { token }), 201);
  });

  app.post("/tokens/verify", async (c) => {
    const body = await parseBody(c, z.object({ token: z.string().min(1) }));
    const { row, machine } = await verifyMachineToken(ctx, body.token);
    return c.json({ valid: true, ...serializeMachineToken(row), machine: serializeMachine(machine) });
  });

  app.get("/tokens", (c) => {
    const page = parsePagination(c);
    const { data, totalCount } = listMachineTokens(ctx, {
      machineId: c.req.query("machine_id") || undefined,
      limit: page.limit,
      offset: page.offset,
      orderBy: page.order_by,
    });
    return c.json({ data: data.map((r) => serializeMachineToken(r)), total_count: totalCount });
  });

  app.post("/tokens/:id/revoke", (c) => {
    const row = requireMachineToken(ctx, c.req.param("id"));
    return c.json(serializeMachineToken(revokeMachineToken(ctx, row)));
  });

  return app;
}
