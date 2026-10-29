/**
 * The OpenAPI 3.1 description of the whole HTTP surface, built as typed objects.
 *
 * `paths/` holds one module per area. The drift test compares this document against `app.routes`, so a new route
 * without an entry here fails CI; `scripts/export-openapi.ts` writes the same object to `docs/openapi.json`.
 */
import { allSchemas } from "./components";
import { arr, obj, opt, ref, str, type Schema } from "./schema";
import type { DocumentedOperation } from "./operation";
import { PARAMETER_COMPONENTS, tagList } from "./operation";
import { backendPaths } from "./paths/backend";
import { frontendPaths } from "./paths/frontend";
import { healthPaths } from "./paths/health";
import { oauthPaths, ssoPaths } from "./paths/oauth";
import { organizationPaths } from "./paths/organizations";
import { apiKeyPaths, m2mPaths, webhookPaths } from "./paths/webhooks";

const operations: DocumentedOperation[] = [
  ...healthPaths,
  ...frontendPaths,
  ...organizationPaths,
  ...backendPaths,
  ...webhookPaths,
  ...apiKeyPaths,
  ...m2mPaths,
  ...oauthPaths,
  ...ssoPaths,
];

/** The error envelope every JSON endpoint returns (`ApiErrorBody` in `@orbitid/shared`). */
const apiError = obj({
  errors: arr(
    obj(
      {
        code: str({ description: "Stable machine-readable code, for example `form_password_incorrect`." }),
        message: str({ description: "Short human-readable message, safe to show to the end user." }),
        long_message: opt(str({ description: "Longer explanation with the fix, when there is one." })),
        meta: opt(obj({}, { additional: true, description: "Extra context such as `param_name`, `retry_after` or `levels`." })),
      },
      { additional: true },
    ),
    { minItems: 1, description: "One entry per problem; a single request can report several validation errors." },
  ),
  trace_id: opt(str({ description: "Correlation id for the request. Include it when reporting a problem." })),
});

export interface OpenApiOptions {
  /** Public base URL of the instance, used for the server entry and for the docs page. */
  baseUrl: string;
}

/** Error responses shared by every operation, so the wording and the schema stay in one place. */
const errorResponses = {
  BadRequest: {
    description: "The request could not be read: malformed JSON, an unparsable body or an invalid query parameter.",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  Unauthorized: {
    description: "Missing or invalid credentials. The Frontend API also answers this when the client cookie is gone.",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  Forbidden: {
    description:
      "Authenticated but not allowed. The Frontend API also returns this for a pending session that still has to " +
      "enrol a second factor (`session_pending`), and for missing organization permissions.",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  NotFound: {
    description: "The resource does not exist, or it belongs to someone else.",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  Conflict: {
    description: "The request conflicts with existing state: a duplicate record, an already accepted invitation, or the last admin.",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  UnprocessableEntity: {
    description: "Validation failed on the request body or query. `meta.param_name` names the offending field.",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  TooManyRequests: {
    description: "Rate limited. `Retry-After` says how many seconds to wait, and `errors[0].code` is `rate_limit_exceeded`.",
    headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds until the next attempt is allowed." } },
    content: { "application/json": { schema: ref("ApiError") } },
  },
  Gone: {
    description: "The resource existed but is no longer available, for example an expired device code.",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  BadGateway: {
    description: "An outbound provider (email, identity provider, SMS) refused or failed the call. The message never contains a provider credential.",
    content: { "application/json": { schema: ref("ApiError") } },
  },
  ServiceUnavailable: {
    description: "A required capability is not configured on this instance, for example `email_not_configured`.",
    content: { "application/json": { schema: ref("ApiError") } },
  },
} satisfies Record<string, unknown>;

/** The same statuses for OAuth protocol endpoints, which answer with RFC 6749's `{ error, error_description }`. */
const oauthErrorResponses = {
  OAuthBadRequest: {
    description: "The request is malformed or an OAuth parameter is missing; `error` names the RFC 6749 code.",
    content: { "application/json": { schema: ref("OAuthError") } },
  },
  OAuthUnauthorized: {
    description: "Client authentication failed (`invalid_client`), or the bearer token is missing or invalid.",
    headers: { "WWW-Authenticate": { schema: { type: "string", example: 'Basic realm="orbitid"' } } },
    content: { "application/json": { schema: ref("OAuthError") } },
  },
} satisfies Record<string, unknown>;

export function buildOpenApi(options: OpenApiOptions) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const path = (paths[operation.path] ??= {});
    path[operation.method] = operation.document;
  }
  const schemas: Record<string, Schema> = { ...allSchemas, ApiError: apiError };
  return {
    openapi: "3.1.0",
    info: {
      title: "OrbitID API",
      version: "0.1.0",
      summary: "Authentication, users, organizations, webhooks and OIDC for a self-hosted OrbitID instance.",
      description: [
        "OrbitID exposes three surfaces on one origin.",
        "",
        "- **Frontend API** (`/v1/client/*`): for browsers. Authenticated by the httpOnly `__client` cookie, which is",
        "  created on first use. Never call it with a secret key.",
        "- **Backend API** (`/v1/*`): for your servers. Every request needs `Authorization: Bearer sk_...` with the",
        "  instance secret key. Responses include `private_metadata`.",
        "- **OAuth/OIDC provider** (`/oauth/*`, `/.well-known/*`): standard endpoints for third-party clients.",
        "",
        "All JSON is snake_case, all timestamps are Unix epoch **milliseconds**, and every id is prefixed with its",
        "object type (`user_...`, `sess_...`, `org_...`). Errors use the envelope described by the `ApiError` schema,",
        "except on the OAuth protocol endpoints, which answer with the standard `{ error, error_description }` shape.",
        "List endpoints on the Backend API return `{ data, total_count }` and accept `limit`, `offset` and `order_by`.",
        "",
        "Rate-limited endpoints answer `429` with a `Retry-After` header in seconds. Sensitive flows (sign-in,",
        "sign-up, code verification, session-token minting) are limited per IP and per identifier.",
      ].join("\n"),
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: options.baseUrl, description: "This instance." }],
    tags: tagList,
    security: [],
    paths,
    components: {
      schemas,
      responses: { ...errorResponses, ...oauthErrorResponses },
      parameters: PARAMETER_COMPONENTS,
      securitySchemes: {
        SecretKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "sk_...",
          description:
            "Instance secret key (`sk_live_...` / `sk_test_...`) as `Authorization: Bearer sk_...`. Grants full " +
            "Backend API access, so it must only ever be used from a server you control.",
        },
        ClientCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__client",
          description: "Opaque client token set by `GET /v1/client` as an httpOnly cookie. One per browser or device.",
        },
        SessionToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Session JWT (RS256, 60 s lifetime) minted by `POST /v1/client/sessions/{id}/tokens`.",
        },
        OAuth2: {
          type: "oauth2",
          description: "Access token issued by this instance's `/oauth/token` endpoint for an OAuth application.",
          flows: {
            authorizationCode: {
              authorizationUrl: `${options.baseUrl}/oauth/authorize`,
              tokenUrl: `${options.baseUrl}/oauth/token`,
              refreshUrl: `${options.baseUrl}/oauth/token`,
              scopes: {
                openid: "Issue an id_token and allow /oauth/userinfo.",
                profile: "Name, picture and profile claims.",
                email: "Email address and whether it is verified.",
                offline_access: "Issue a refresh token.",
              },
            },
            clientCredentials: {
              tokenUrl: `${options.baseUrl}/oauth/m2m/token`,
              scopes: { "machine:token": "Mint tokens as a machine identity." },
            },
          },
        },
        MachineSecret: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "mk_...",
          description: "Machine secret from `POST /v1/m2m/machines`. Only `/oauth/m2m/token` accepts it.",
        },
      },
    },
  };
}

export type OpenApiDocument = ReturnType<typeof buildOpenApi>;
