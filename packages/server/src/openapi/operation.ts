/** Builders for OpenAPI operations, so every route carries the same metadata and error envelope. */
import type { ZodTypeAny } from "zod";
import { fromZod } from "./from-zod";
import type { Schema } from "./schema";

export const Tags = {
  signIn: "Sign in",
  signUp: "Sign up",
  sessions: "Sessions",
  usersFrontend: "Users (frontend)",
  usersBackend: "Users (backend)",
  organizations: "Organizations",
  invitations: "Invitations",
  webhooks: "Webhooks",
  apiKeys: "API keys",
  m2m: "M2M",
  oauth: "OAuth/OIDC",
  sso: "Enterprise SSO",
  instance: "Instance",
  health: "Health",
} as const;

export const tagList = [
  { name: Tags.signIn, description: "Start and advance a sign-in on the Frontend API. Responses also carry the updated client." },
  { name: Tags.signUp, description: "Create an account and verify its identifiers on the Frontend API." },
  { name: Tags.sessions, description: "Sessions and session tokens for the current client, plus session management for operators." },
  { name: Tags.usersFrontend, description: "The signed-in user's own profile, identifiers, MFA factors and API keys." },
  { name: Tags.usersBackend, description: "User management with the Backend API: CRUD, filters, metadata, bans, locks and MFA resets." },
  { name: Tags.organizations, description: "Organizations, memberships, invitations, domains, roles and membership requests." },
  { name: Tags.invitations, description: "Instance-level invitations and the waitlist that feeds them." },
  { name: Tags.webhooks, description: "Webhook endpoints, event types and delivery logs." },
  { name: Tags.apiKeys, description: "API keys for users and organizations, plus verification of a presented key." },
  { name: Tags.m2m, description: "Machine identities and the tokens they mint." },
  { name: Tags.oauth, description: "The OAuth 2.0 / OpenID Connect provider, its discovery documents and application management." },
  { name: Tags.sso, description: "SAML 2.0 and enterprise OIDC connections, and the browser flows that use them." },
  { name: Tags.instance, description: "Instance settings, signing keys, audit logs and statistics." },
  { name: Tags.health, description: "Unauthenticated liveness and key discovery." },
];

/** Which error envelope an operation returns. OAuth protocol endpoints use RFC 6749's `{ error, error_description }`. */
export type ErrorShape = "orbit" | "oauth";

/** Which credential an operation accepts. */
export type Security = "none" | "backend" | "frontend" | "frontendOptional" | "oauth" | "machineSecret";

export interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description?: string;
  schema: Schema;
}

/** A parameter defined once in `components.parameters` and referenced by an operation. */
export interface ParameterRef {
  $ref: string;
}

export type AnyParameter = Parameter | ParameterRef;

/**
 * Reusable parameters. Pagination, ordering and the `paginated` switch behave identically on every list endpoint, so
 * they live in `components.parameters` and operations point at them.
 */
export const PARAMETER_COMPONENTS: Record<string, Parameter> = {
  Limit: { name: "limit", in: "query", description: "Rows to return (1–500).", schema: { type: "integer", minimum: 1, maximum: 500, default: 10 } },
  Offset: { name: "offset", in: "query", description: "Rows to skip.", schema: { type: "integer", minimum: 0, default: 0 } },
  OrderBy: {
    name: "order_by",
    in: "query",
    description: "Sort field, prefixed with `-` for descending (`-created_at`) or `+` for ascending. An unknown field falls back to the endpoint's default order.",
    schema: { type: "string" },
  },
  Paginated: {
    name: "paginated",
    in: "query",
    description: "When `true`, the response is `{ data, total_count }` instead of the plain envelope.",
    schema: { type: "string", enum: ["true"] },
  },
};

export const parameterRef = (name: keyof typeof PARAMETER_COMPONENTS): ParameterRef => ({ $ref: `#/components/parameters/${name}` });

export interface OperationInput {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  tag: string;
  summary: string;
  operationId: string;
  security?: Security;
  description?: string;
  deprecated?: boolean;
  parameters?: AnyParameter[];
  /** Request body schema (JSON Schema, or a zod schema that is converted); adds `400` and `422` to the documented errors. */
  body?: { schema: Schema | ZodTypeAny; contentType?: string; description?: string; required?: boolean };
  /** The success status and its body. `302` is used by the browser redirect endpoints. */
  success?: { status: 200 | 201 | 202 | 204 | 302; schema?: Schema; contentType?: string; description?: string; headers?: Record<string, Schema> };
  /** Additional error statuses. `400`, `401`, `404` and `422` are inferred from the operation. */
  errors?: (400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 502 | 503)[];
  /** Defaults to the OrbitID envelope. OAuth protocol endpoints answer with the OAuth error shape instead. */
  errorShape?: ErrorShape;
}

export interface DocumentedOperation {
  method: string;
  path: string;
  operationId: string;
  tag: string;
  document: Record<string, unknown>;
}

const securityFor = (security: Security): Record<string, string[]>[] => {
  switch (security) {
    case "backend": return [{ SecretKey: [] }];
    case "frontend": return [{ ClientCookie: [] }, { SessionToken: [] }];
    case "frontendOptional": return [{ ClientCookie: [] }, { SessionToken: [] }, {}];
    case "oauth": return [{ OAuth2: [] }];
    case "machineSecret": return [{ MachineSecret: [] }];
    // Public endpoints state it explicitly: an empty requirement list is "no credentials".
    default: return [];
  }
};

/**
 * Error statuses every endpoint can answer, as shared `components.responses` entries. Keeping them in one place keeps
 * the document small and the wording consistent; `index.ts` defines the matching response objects.
 */
export const ERROR_RESPONSE_NAMES: Record<number, string> = {
  400: "BadRequest",
  401: "Unauthorized",
  403: "Forbidden",
  404: "NotFound",
  409: "Conflict",
  410: "Gone",
  422: "UnprocessableEntity",
  429: "TooManyRequests",
  502: "BadGateway",
  503: "ServiceUnavailable",
};

const errorResponse = (status: number, shape: ErrorShape) => {
  const name = ERROR_RESPONSE_NAMES[status];
  // Every status an operation can answer must have a shared response, so the wording lives in one place.
  if (!name) throw new Error(`no shared response component for status ${status}`);
  // OAuth protocol endpoints answer protocol errors with `{ error, error_description }`; a request body that fails
  // zod validation still takes the OrbitID envelope, because `parseBody` throws `OrbitError`.
  const oauth = shape === "oauth" && (status === 400 || status === 401);
  return { $ref: `#/components/responses/${oauth ? `OAuth${name}` : name}` };
};

const isZod = (value: unknown): value is ZodTypeAny => typeof value === "object" && value !== null && "_def" in (value as Record<string, unknown>);

/** Request bodies are written as zod where a schema already exists and as JSON Schema where it does not. */
const toSchema = (value: Schema | ZodTypeAny): Schema => (isZod(value) ? fromZod(value) : value);

/** Turns an operation definition into a real OpenAPI operation object. */
export function operation(input: OperationInput): DocumentedOperation {
  const security = input.security ?? "none";
  const success = input.success;
  const statuses = new Set<number>(input.errors ?? []);
  statuses.add(400);
  // `frontendOptional` accepts an anonymous caller (it creates a client), so 401 does not apply.
  if (security !== "none" && security !== "frontendOptional") statuses.add(401);
  // Any path parameter can name a row that does not exist (or belongs to someone else), so 404 is always plausible.
  if (input.errors?.includes(404) || input.parameters?.some((p) => "$ref" in p ? false : p.in === "path")) statuses.add(404);
  if (input.body) statuses.add(422);

  const responses: Record<string, unknown> = {};
  if (!success) throw new Error(`${input.operationId}: an operation needs a success response`);
  responses[String(success.status)] = {
    description: success.description ?? (success.status === 204 ? "No content." : success.status === 302 ? "Redirect." : "Success."),
    ...(success.schema
      ? {
          content: {
            [success.contentType ?? "application/json"]: { schema: success.schema },
          },
        }
      : {}),
    ...(success.headers
      ? { headers: Object.fromEntries(Object.entries(success.headers).map(([name, schema]) => [name, { schema }])) }
      : {}),
  };
  for (const status of [...statuses].sort((a, b) => a - b)) responses[String(status)] = errorResponse(status, input.errorShape ?? "orbit");

  const document: Record<string, unknown> = {
    tags: [input.tag],
    summary: input.summary,
    operationId: input.operationId,
    ...(input.description ? { description: input.description } : {}),
    ...(input.deprecated ? { deprecated: true } : {}),
    ...(securityFor(security) ? { security: securityFor(security) } : {}),
    ...(input.parameters?.length
      ? {
          parameters: input.parameters.map((p) => "$ref" in p ? p : {
            name: p.name,
            in: p.in,
            required: p.in === "path" ? true : (p.required ?? false),
            ...(p.description ? { description: p.description } : {}),
            schema: p.schema,
          }),
        }
      : {}),
    ...(input.body
      ? {
          requestBody: {
            required: input.body.required ?? true,
            ...(input.body.description ? { description: input.body.description } : {}),
            content: { [input.body.contentType ?? "application/json"]: { schema: toSchema(input.body.schema) } },
          },
        }
      : {}),
    responses,
  };
  return { method: input.method, path: input.path, operationId: input.operationId, tag: input.tag, document };
}

/**
 * Compact declaration used by the path modules: `op("get", "/v1/users", Tags.usersBackend, "listUsers",
 * "List users", { ... })`.
 */
export function op(
  method: OperationInput["method"],
  path: string,
  tag: string,
  operationId: string,
  summary: string,
  rest: Omit<OperationInput, "method" | "path" | "tag" | "operationId" | "summary"> = {},
): DocumentedOperation {
  return operation({ method, path, tag, operationId, summary, ...rest });
}

/** Common path parameter definitions. */
export const pathParam = (name: string, description?: string): Parameter => ({ name, in: "path", description, schema: { type: "string" } });
export const queryParam = (name: string, schema: Schema, description?: string): Parameter => ({ name, in: "query", description, schema });
export const idPath = pathParam("id", "The resource id, prefixed with its object type (`user_…`, `sess_…`, `org_…`).");
export const backendListParams: AnyParameter[] = [parameterRef("Limit"), parameterRef("Offset"), parameterRef("OrderBy")];
export const paginatedParam = parameterRef("Paginated");
