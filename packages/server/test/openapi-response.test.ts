import { describe, it, expect } from "vitest";
import { buildOpenApi } from "../src/openapi";
import { listRoutes, routeKey } from "../src/openapi/routes";
import { setup, testClient } from "./core/helpers";
import { testApp as adminApp, createUser } from "./admin/helpers";
import { latestCodeFor } from "../src/services/mail";

/**
 * Spot checks that real responses match the schema the document promises.
 *
 * The document is the contract, so the payloads below are checked against it rather than against hand-written shapes.
 * A small validator covers the JSON Schema subset `src/openapi` emits; anything outside that subset fails loudly
 * instead of passing silently.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const spec = buildOpenApi({ baseUrl: "http://localhost:4000" });

function resolvePointer(pointer: string): unknown {
  const parts = pointer.replace(/^#\//, "").split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = spec;
  for (const part of parts) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Json)[part];
  }
  return current;
}

/** Returns a list of problems; empty means the value matches. */
function validate(value: unknown, schema: unknown, path = "$", depth = 0): string[] {
  if (!isObject(schema) || depth > 24) return [];
  if (typeof schema.$ref === "string") {
    const target = resolvePointer(schema.$ref);
    if (!target) return [`${path}: unresolvable $ref ${schema.$ref}`];
    return validate(value, target, path, depth + 1);
  }
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((variant) => validate(value, variant, path, depth + 1));
    return results.some((problems) => problems.length === 0) ? [] : [`${path}: matches none of anyOf (${results.map((r) => r[0]).join("; ")})`];
  }
  if (Array.isArray(schema.allOf)) return schema.allOf.flatMap((part) => validate(value, part, path, depth + 1));
  if ("const" in schema && value !== schema.const) return [`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`];

  const problems: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
    const ok = types.some((type) => type === actual || (type === "number" && actual === "integer"));
    if (!ok) return [`${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    return [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) problems.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) problems.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) problems.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) problems.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((item, index) => problems.push(...validate(item, schema.items, `${path}[${index}]`, depth + 1)));
    if (typeof schema.minItems === "number" && value.length < schema.minItems) problems.push(`${path}: fewer than ${schema.minItems} items`);
    return problems;
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!(name in value)) problems.push(`${path}.${name}: required but missing`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (properties[name]) problems.push(...validate(item, properties[name], `${path}.${name}`, depth + 1));
      else if (schema.additionalProperties === false) problems.push(`${path}.${name}: not allowed`);
      else if (isObject(schema.additionalProperties)) problems.push(...validate(item, schema.additionalProperties, `${path}.${name}`, depth + 1));
    }
  }
  return problems;
}

/** The documented `200` schema of an operation, found by operationId. */
function responseSchema(operationId: string, status = "200"): unknown {
  for (const item of Object.values(spec.paths as Record<string, Json>)) {
    for (const operation of Object.values(item)) {
      if (!isObject(operation) || operation.operationId !== operationId) continue;
      const response = (operation.responses as Json)[status] as Json;
      const resolved = (response.$ref ? (resolvePointer(response.$ref as string) as Json) : response);
      const content = resolved.content as Json;
      return (Object.values(content)[0] as Json).schema;
    }
  }
  throw new Error(`no documented operation ${operationId}`);
}

function expectMatches(value: unknown, operationId: string, status?: string): void {
  const problems = validate(value, responseSchema(operationId, status));
  expect(problems, `${operationId} response does not match the documented schema`).toEqual([]);
}

describe("documented responses match real payloads", () => {
  it("sign-up creation, verification and the session list", async () => {
    const { app } = await setup();
    const client = testClient(app);
    const email = "documented@example.com";

    const created = await client.json<{ response: Json; client: Json }>("/v1/client/sign_ups", {
      body: { email_address: email, password: "Sup3rSecret!", first_name: "Ada", last_name: "Lovelace" },
    });
    expectMatches(created, "createSignUp");

    await client.json(`/v1/client/sign_ups/${created.response.id as string}/prepare_verification`, { body: { strategy: "email_code" } });
    const completed = await client.json<{ response: Json; client: Json }>(
      `/v1/client/sign_ups/${created.response.id as string}/attempt_verification`,
      { body: { strategy: "email_code", code: latestCodeFor(email)! } },
    );
    expectMatches(completed, "attemptSignUpVerification");

    const sessions = await client.json<{ response: Json[] }>("/v1/client/sessions");
    expectMatches(sessions, "listClientSessions");
    expect(sessions.response.length).toBe(1);

    const tokens = await client.json<{ jwt: string }>(`/v1/client/sessions/${sessions.response[0]!.id as string}/tokens`, { body: {} });
    expectMatches(tokens, "createSessionToken");

    const me = await client.json<{ response: Json }>("/v1/client/me");
    expectMatches(me, "getMe");
  });

  it("creating and listing users with the Backend API", async () => {
    const { api, ctx } = await adminApp();
    // Organizations are off by default; the Backend API is gated by the same switch, so turn them on to list them.
    await ctx.settings.update({ organizations: { enabled: true } });
    const created = await createUser(api, { email_address: ["documented-backend@example.com"], password: "Sup3r-secret!", public_metadata: { tier: "pro" } });
    expectMatches(created, "createUser");

    const list = await (await api("GET", "/v1/users?paginated=true")).json();
    expectMatches(list, "listUsers");
    expect((list as { total_count: number }).total_count).toBe(1);

    const bare = await (await api("GET", "/v1/users")).json();
    expectMatches(bare, "listUsers");

    const one = await (await api("GET", `/v1/users/${created.id}`)).json();
    expectMatches(one, "getUser");

    const organizations = await (await api("GET", "/v1/organizations?paginated=true")).json();
    expectMatches(organizations, "listOrganizations");

    const sessions = await (await api("GET", "/v1/sessions?paginated=true")).json();
    expectMatches(sessions, "listSessions");

    const errors = await (await api("GET", "/v1/users/user_missing")).json();
    expectMatches(errors, "getUser", "404");
  });

  it("the documented error envelope matches a real error", async () => {
    const { app } = await setup();
    const response = await app.request("/v1/users");
    expect(response.status).toBe(401);
    const body = await response.json();
    const problems = validate(body, spec.components.schemas.ApiError);
    expect(problems).toEqual([]);
  });

  it("the health and discovery documents match", async () => {
    const { app } = await setup();
    expectMatches(await (await app.request("/health")).json(), "getHealth");
    expectMatches(await (await app.request("/.well-known/openid-configuration")).json(), "getOpenIdConfiguration");
    expectMatches(await (await app.request("/.well-known/jwks.json")).json(), "getJwks");
    expectMatches(await (await app.request("/v1/client/environment")).json(), "getEnvironment");
  });

  it("instance settings, stats and webhook endpoints match", async () => {
    const { api } = await adminApp();
    expectMatches(await (await api("GET", "/v1/instance")).json(), "getInstance");
    expectMatches(await (await api("GET", "/v1/stats")).json(), "getInstanceStats");
    expectMatches(await (await api("GET", "/v1/audit_logs?paginated=true")).json(), "listAuditLogs");
    expectMatches(await (await api("GET", "/v1/webhooks/event_types")).json(), "listWebhookEventTypes");

    const endpoint = await (await api("POST", "/v1/webhooks/endpoints", { url: "https://example.com/hook", event_types: ["user.created"] })).json();
    expectMatches(endpoint, "createWebhookEndpoint", "201");
    expectMatches(await (await api("GET", `/v1/webhooks/endpoints/${(endpoint as Json).id as string}`)).json(), "getWebhookEndpoint");
    expectMatches(await (await api("GET", `/v1/webhooks/endpoints/${(endpoint as Json).id as string}/secret`)).json(), "getWebhookEndpointSecret");
  });

  it("every documented path is registered under the method it documents", async () => {
    const { app } = await setup();
    const registered = new Set(listRoutes(app).map(routeKey));
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths as Record<string, Json>)) {
      for (const method of Object.keys(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        if (!registered.has(`${method.toUpperCase()} ${path}`)) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
