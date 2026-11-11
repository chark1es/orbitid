/** backend paths: instance. */
import { obj, opt, ref, str } from "../../schema";
import { backendListParams, idPath, op, pathParam, queryParam, type DocumentedOperation } from "../../operation";
import * as body from "../../requests";
import { list, ok } from "../common";

export const operations: DocumentedOperation[] = [
  // ───────────── JWT templates ─────────────
  op("get", "/v1/jwt_templates", "Sessions", "listJwtTemplates", "List JWT templates", {
    security: "backend",
    parameters: backendListParams,
    ...list(ref("JwtTemplate")),
    errors: [429],
  }),
  op("get", "/v1/jwt_templates/{id}", "Sessions", "getJwtTemplate", "Read a JWT template", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("JwtTemplate")),
    errors: [404],
  }),
  op("post", "/v1/jwt_templates", "Sessions", "createJwtTemplate", "Create a JWT template", {
    security: "backend",
    description:
      "Template names may contain letters, digits, `-` and `_`. Session claims (`iss`, `sub`, `exp`, `org_*`, …) are " +
      "reserved and rejected. `custom_signing_key` generates a key pair (RS256/ES256) or HMAC secret (HS256); the " +
      "verification key is returned in `signing_key`.",
    body: { schema: body.jwtTemplateCreate },
    ...ok(ref("JwtTemplate")),
    errors: [422],
  }),
  op("patch", "/v1/jwt_templates/{id}", "Sessions", "updateJwtTemplate", "Update a JWT template", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.jwtTemplateCreate },
    ...ok(ref("JwtTemplate")),
    errors: [404, 422],
  }),
  op("delete", "/v1/jwt_templates/{id}", "Sessions", "deleteJwtTemplate", "Delete a JWT template", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "jwt_template" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),

  // ───────────── instance ─────────────
  op("get", "/v1/instance", "Instance", "getInstance", "Read instance settings", {
    security: "backend",
    description: "The full settings tree with secrets masked as `••••` and a sibling `<field>Set` boolean.",
    ...ok(ref("Instance")),
    errors: [429],
  }),
  op("patch", "/v1/instance", "Instance", "updateInstance", "Update instance settings", {
    security: "backend",
    description:
      "Deep-merges a partial settings tree and validates it against the settings schema. Omit masked secrets to keep " +
      "them; `null` deletes a key. Application URLs must be absolute http(s) URLs.",
    body: { schema: body.instancePatch },
    ...ok(ref("Instance")),
    errors: [422],
  }),
  op("post", "/v1/instance/test_email", "Instance", "sendTestEmail", "Send a test email", {
    security: "backend",
    description: "Sends a test message through the configured mail transport. Malformed recipients answer 422; missing or failed delivery answers 503. No console or file fallback.",
    body: { schema: body.testEmail },
    success: { status: 200, schema: obj({ status: { const: "ok" }, to: str() }) },
    errors: [422, 503],
  }),
  op("post", "/v1/instance/email_test", "Instance", "testEmailDelivery", "Send a test email and report the provider used", {
    security: "backend",
    description:
      "Sends a message through the resolved transport (Resend or SMTP) and reports which one it used. No provider means 503, never console or file delivery. " +
      "A delivery failure answers 502 with a message that never contains the provider key. Rate limited per address and overall.",
    body: { schema: obj({ to: str({ description: "Recipient address." }) }) },
    success: { status: 200, schema: obj({ provider: { type: "string", enum: ["resend", "smtp"] }, ok: { const: true } }) },
    errors: [422, 429, 502, 503],
  }),
  op("post", "/v1/instance/social/test", "Instance", "testSocialProvider", "Check a custom identity provider's endpoints", {
    security: "backend",
    description:
      "Resolves a discovery document (or validates manual endpoints), probes each endpoint and reports what the " +
      "provider advertises: issuer, scopes, PKCE support and token-endpoint authentication methods. Nothing is " +
      "saved. Errors are returned in the body so a dashboard can show all of them at once. Rate limited.",
    body: {
      schema: obj({
        protocol: opt({ type: "string", enum: ["oidc", "oauth2"] }),
        discoveryUrl: opt(str({ format: "uri" })),
        issuer: opt(str()),
        authorizationUrl: opt(str({ format: "uri" })),
        tokenUrl: opt(str({ format: "uri" })),
        userinfoUrl: opt(str({ format: "uri" })),
        jwksUrl: opt(str({ format: "uri" })),
      }),
    },
    success: {
      status: 200,
      schema: obj({
        ok: { type: "boolean" },
        protocol: { type: "string", enum: ["oidc", "oauth2"] },
        issuer: opt(str()),
        endpoints: obj({ authorization: str(), token: str(), userinfo: opt(str()), jwks: opt(str()) }),
        scopes_supported: opt({ type: "array", items: { type: "string" } }),
        pkce_supported: opt({ type: "boolean" }),
        client_auth_methods: opt({ type: "array", items: { type: "string" } }),
        checks: { type: "array", items: obj({ name: str(), url: str(), reachable: { type: "boolean" }, status: opt({ type: "integer" }), error: opt(str()) }) },
        warnings: { type: "array", items: { type: "string" } },
        errors: { type: "array", items: { type: "string" } },
      }),
    },
    errors: [429],
  }),
  op("delete", "/v1/instance/social/{provider}", "Instance", "deleteSocialProvider", "Delete a custom social provider", {
    security: "backend",
    description: "Removes a `custom_<key>` provider from instance settings. Built-in providers can only be turned off.",
    parameters: [pathParam("provider", "Custom provider key, for example `custom_acme`.")],
    ...ok(ref("Instance")),
    errors: [404, 422],
  }),
  op("post", "/v1/instance/signing_keys/rotate", "Instance", "rotateSigningKey", "Rotate the session signing key", {
    security: "backend",
    description:
      "Creates a new active signing key. Old keys stay in the JWKS until their tokens expire, so offline verifiers " +
      "keep working across the rotation.",
    success: { status: 200, schema: ref("SigningKey") },
    errors: [],
  }),
  op("post", "/v1/testing_tokens", "Instance", "createTestingToken", "Create a testing token", {
    security: "backend",
    description:
      "Only when testing tokens are enabled. Testing tokens bypass bot protection in test suites; they expire after " +
      "one hour. Never use them in production.",
    success: { status: 200, schema: ref("TestingToken") },
    errors: [403],
  }),
  op("get", "/v1/audit_logs", "Instance", "listAuditLogs", "List audit logs", {
    security: "backend",
    description: "Newest first. Filters: `actor`, `action`, `target_type`, `target_id` and the `after`/`before` epoch millisecond bounds.",
    parameters: [
      ...backendListParams,
      queryParam("actor", { type: "string" }),
      queryParam("action", { type: "string" }),
      queryParam("target_type", { type: "string" }),
      queryParam("target_id", { type: "string" }),
      queryParam("after", { type: "integer" }, "Epoch milliseconds."),
      queryParam("before", { type: "integer" }, "Epoch milliseconds."),
    ],
    ...list(ref("AuditLog")),
    errors: [429],
  }),
  op("get", "/v1/stats", "Instance", "getInstanceStats", "Read instance statistics", {
    security: "backend",
    description: "Totals plus the last 30 UTC days of sign-ups and sign-ins, for the dashboard charts.",
    ...ok(ref("InstanceStats")),
    errors: [429],
  }),
];
