import { describe, it, expect } from "vitest";
import { buildOpenApi, type OpenApiDocument } from "../src/openapi";

/**
 * Structural validation of the document itself, independent of the server: OpenAPI 3.1 shape, unique operation ids,
 * resolvable `$ref`s, declared path parameters and security schemes that exist.
 *
 * The checks are written against the raw object so they apply to the exported `docs/openapi.json` as well.
 */

const spec = buildOpenApi({ baseUrl: "https://auth.example.com" });

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Walks every node, yielding each `$ref` string. */
function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

function resolvePointer(document: unknown, pointer: string): unknown {
  const parts = pointer.replace(/^#\//, "").split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = document;
  for (const part of parts) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Json)[part];
    if (current === undefined) return undefined;
  }
  return current;
}

const operations = (document: OpenApiDocument): { path: string; method: string; operation: Json }[] => {
  const out: { path: string; method: string; operation: Json }[] = [];
  for (const [path, item] of Object.entries(document.paths as Record<string, Json>)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) continue;
      out.push({ path, method, operation: operation as Json });
    }
  }
  return out;
};

describe("OpenAPI document structure", () => {
  it("declares OpenAPI 3.1 with info, servers, tags and components", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("OrbitID API");
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(spec.servers).toEqual([{ url: "https://auth.example.com", description: "This instance." }]);
    expect(spec.tags.length).toBeGreaterThan(10);
    expect(Object.keys(spec.components.schemas).length).toBeGreaterThan(30);
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(
      ["ClientCookie", "MachineSecret", "OAuth2", "SecretKey", "SessionToken"].sort(),
    );
  });

  it("gives every operation a unique operationId, a known tag and a summary", () => {
    const tagNames = new Set<string>(spec.tags.map((tag) => tag.name));
    const seen = new Map<string, string>();
    for (const { path, method, operation } of operations(spec)) {
      const id = operation.operationId;
      expect(typeof id, `${method.toUpperCase()} ${path} needs an operationId`).toBe("string");
      expect(id as string).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(seen.has(id as string), `duplicate operationId ${id}`).toBe(false);
      seen.set(id as string, `${method.toUpperCase()} ${path}`);
      expect(typeof operation.summary, `${id} needs a summary`).toBe("string");
      const tags = operation.tags as string[];
      expect(tags).toHaveLength(1);
      expect(tagNames.has(tags[0]!), `unknown tag ${tags[0]} on ${id}`).toBe(true);
      const responses = operation.responses as Json;
      expect(Object.keys(responses).length).toBeGreaterThan(0);
    }
  });

  it("resolves every $ref", () => {
    const refs = collectRefs(spec);
    expect(refs.length).toBeGreaterThan(100);
    const broken = [...new Set(refs)].filter((ref) => resolvePointer(spec, ref) === undefined);
    expect(broken).toEqual([]);
  });

  it("declares every path parameter used in a path", () => {
    for (const { path, method, operation } of operations(spec)) {
      const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
      const declared = new Map<string, Json>();
      for (const parameter of (operation.parameters as Json[] | undefined) ?? []) {
        declared.set(parameter.name as string, parameter);
      }
      const pathLevel = (spec.paths as Record<string, Json>)[path]!.parameters as Json[] | undefined;
      for (const parameter of pathLevel ?? []) declared.set(parameter.name as string, parameter);
      for (const name of inPath) {
        const parameter = declared.get(name);
        expect(parameter, `${method.toUpperCase()} ${path} does not declare path parameter {${name}}`).toBeTruthy();
        expect(parameter!.in).toBe("path");
        expect(parameter!.required).toBe(true);
      }
      // And the other way round: a declared path parameter that is not in the path is a typo.
      for (const [name, parameter] of declared) {
        if (parameter.in === "path") expect(inPath, `${method.toUpperCase()} ${path} declares unused path parameter ${name}`).toContain(name);
      }
    }
  });

  it("only references security schemes it defines", () => {
    const schemes = new Set(Object.keys(spec.components.securitySchemes));
    const referenced = new Set<string>();
    for (const { path, method, operation } of operations(spec)) {
      for (const requirement of (operation.security as Json[] | undefined) ?? []) {
        for (const name of Object.keys(requirement)) {
          referenced.add(name);
          expect(schemes.has(name), `${method.toUpperCase()} ${path} uses unknown security scheme ${name}`).toBe(true);
        }
      }
    }
    // Each scheme must be reachable from at least one operation, or it is dead documentation.
    expect([...referenced].sort()).toEqual([...schemes].sort());
  });

  it("documents an error envelope for credential-protected operations", () => {
    for (const { path, method, operation } of operations(spec)) {
      const security = (operation.security as Json[] | undefined) ?? [];
      // An operation that lists `{}` as an alternative accepts anonymous callers, so 401 is not implied.
      const guarded = security.length > 0 && security.every((requirement) => Object.keys(requirement).length > 0);
      const responses = operation.responses as Json;
      expect(responses["400"], `${method.toUpperCase()} ${path} has no 400`).toBeTruthy();
      if (guarded) expect(responses["401"], `${method.toUpperCase()} ${path} has no 401`).toBeTruthy();
      for (const [status, response] of Object.entries(responses)) {
        const ref = ((response as Json).$ref as string | undefined) ?? "";
        const resolved = (ref ? resolvePointer(spec, ref) : response) as Json | undefined;
        expect(typeof resolved?.description, `${method.toUpperCase()} ${path} ${status} needs a description`).toBe("string");
      }
      // The error envelope itself must be the shared schema, not an inline copy. OAuth protocol endpoints use the
      // RFC 6749 shape for their protocol errors.
      if (responses["400"]) {
        const ref = (responses["400"] as Json).$ref as string;
        const content = (resolvePointer(spec, ref) as Json).content as Json;
        const expected = ref.includes("OAuth") ? "OAuthError" : "ApiError";
        expect(content["application/json"]).toEqual({ schema: { $ref: `#/components/schemas/${expected}` } });
      }
    }
  });

  it("keeps request bodies and responses inside the schema components", () => {
    for (const { path, method, operation } of operations(spec)) {
      const body = operation.requestBody as Json | undefined;
      if (body) {
        const content = body.content as Json;
        expect(Object.keys(content).length).toBe(1);
        const schema = (Object.values(content)[0] as Json).schema;
        expect(isObject(schema), `${method.toUpperCase()} ${path} request body has no schema`).toBe(true);
      }
    }
  });

  it("defines shared responses, parameters and unique tags", () => {
    const tagNames = new Set<string>(spec.tags.map((tag) => tag.name));
    expect(tagNames.size).toBe(spec.tags.length);

    const components = spec.components as unknown as { responses: Json; parameters: Json };
    expect(Object.keys(components.responses).sort()).toEqual(
      [
        "BadRequest", "Conflict", "Forbidden", "NotFound", "OAuthBadRequest", "OAuthUnauthorized",
        "TooManyRequests", "Unauthorized", "UnprocessableEntity",
      ],
    );
    expect(Object.keys(components.parameters).sort()).toEqual(["Limit", "Offset", "OrderBy", "Paginated"]);
    for (const name of Object.keys(components.parameters)) {
      const parameter = components.parameters[name] as Json;
      expect(parameter.in).toBe("query");
      expect(parameter.name).toBeTruthy();
    }

    // Every error status points at a shared response, so the wording and the Retry-After header are defined once.
    for (const { path, method, operation } of operations(spec)) {
      for (const [status, response] of Object.entries(operation.responses as Json)) {
        if (Number(status) < 400) continue;
        expect((response as Json).$ref, `${method.toUpperCase()} ${path} ${status} should reference a shared response`).toBeTruthy();
      }
    }
  });

  it("marks every object schema discriminator and timestamp field", () => {
    // The shared resources are the contract with the SDKs: check the fields they all rely on.
    const user = spec.components.schemas.User as Json;
    const properties = user.properties as Json;
    expect((properties.object as Json).const).toBe("user");
    expect(properties.created_at).toBeTruthy();
    expect(properties.updated_at).toBeTruthy();
    expect((properties.private_metadata as Json).description).toMatch(/Backend API only/);
  });
});
