/** Webhooks, API keys, M2M machines and tokens. */
import { arr, obj, ref } from "../schema";
import { backendListParams, idPath, op, queryParam, type DocumentedOperation } from "../operation";
import * as body from "../requests";
import { list, ok } from "./common";


export const webhookPaths: DocumentedOperation[] = [
  op("get", "/v1/webhooks/event_types", "Webhooks", "listWebhookEventTypes", "List webhook event types", {
    security: "backend",
    description: "Every event type an endpoint can subscribe to.",
    success: { status: 200, schema: arr({ type: "string" }) },
    errors: [429],
  }),
  op("get", "/v1/webhooks/endpoints", "Webhooks", "listWebhookEndpoints", "List webhook endpoints", {
    security: "backend",
    parameters: backendListParams,
    ...list(ref("WebhookEndpoint")),
    errors: [429],
  }),
  op("post", "/v1/webhooks/endpoints", "Webhooks", "createWebhookEndpoint", "Create a webhook endpoint", {
    security: "backend",
    description: "The `whsec_…` signing secret is returned only in this response and from `GET …/secret`.",
    body: { schema: body.webhookEndpointCreate },
    success: { status: 201, schema: ref("WebhookEndpoint") },
    errors: [422],
  }),
  op("get", "/v1/webhooks/endpoints/{id}", "Webhooks", "getWebhookEndpoint", "Read a webhook endpoint", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("WebhookEndpoint")),
    errors: [404],
  }),
  op("get", "/v1/webhooks/endpoints/{id}/secret", "Webhooks", "getWebhookEndpointSecret", "Read the signing secret", {
    security: "backend",
    description: "Returns the `whsec_…` secret so an existing endpoint can be re-verified without rotating it.",
    parameters: [idPath],
    success: { status: 200, schema: obj({ object: { const: "webhook_endpoint_secret" }, id: { type: "string" }, secret: { type: "string" } }) },
    errors: [404],
  }),
  op("patch", "/v1/webhooks/endpoints/{id}", "Webhooks", "updateWebhookEndpoint", "Update a webhook endpoint", {
    security: "backend",
    description: "`rotate_secret: true` replaces the signing secret and includes the new one in the response.",
    parameters: [idPath],
    body: { schema: body.webhookEndpointUpdate },
    ...ok(ref("WebhookEndpoint")),
    errors: [404, 422],
  }),
  op("delete", "/v1/webhooks/endpoints/{id}", "Webhooks", "deleteWebhookEndpoint", "Delete a webhook endpoint", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "webhook_endpoint" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),
  op("get", "/v1/webhooks/endpoints/{id}/deliveries", "Webhooks", "listWebhookDeliveries", "List deliveries of an endpoint", {
    security: "backend",
    description: "Attempt history, newest first. Filter with `status` (`pending`, `success`, `failed`).",
    parameters: [idPath, ...backendListParams, queryParam("status", { type: "string", enum: ["pending", "success", "failed"] })],
    ...list(ref("WebhookDelivery")),
    errors: [404],
  }),
  op("post", "/v1/webhooks/deliveries/{id}/retry", "Webhooks", "retryWebhookDelivery", "Retry a delivery", {
    security: "backend",
    description: "Queues the stored event for another attempt and returns the delivery row.",
    parameters: [idPath],
    ...ok(ref("WebhookDelivery")),
    errors: [404],
  }),
  op("post", "/v1/webhooks/endpoints/{id}/test", "Webhooks", "testWebhookEndpoint", "Send a test event", {
    security: "backend",
    description: "Delivers a `webhook.test` event so the receiver's signature check can be exercised. Returns the delivery row.",
    parameters: [idPath],
    ...ok(ref("WebhookDelivery")),
    errors: [404],
  }),
];

export const apiKeyPaths: DocumentedOperation[] = [
  op("get", "/v1/api_keys", "API keys", "listApiKeys", "List API keys", {
    security: "backend",
    description: "Filter by `subject`; revoked and expired keys are hidden unless `include_invalid` is true.",
    parameters: [...backendListParams, queryParam("subject", { type: "string" }), queryParam("include_invalid", { type: "string", enum: ["true", "1"] })],
    ...list(ref("ApiKey")),
    errors: [429],
  }),
  op("post", "/v1/api_keys", "API keys", "createApiKey", "Create an API key", {
    security: "backend",
    description: "The `ak_live_…` secret is returned once, in this response. The key is stored hashed.",
    body: { schema: body.apiKeyCreateBackend },
    success: { status: 201, schema: ref("ApiKey") },
    errors: [404, 422],
  }),
  op("post", "/v1/api_keys/verify", "API keys", "verifyApiKey", "Inspect a presented API key", {
    security: "backend",
    description: "Resolves the key metadata for a secret your server received. Expired or revoked keys return 401.",
    body: { schema: body.apiKeyVerify },
    ...ok(ref("ApiKey")),
    errors: [401, 422],
  }),
  op("get", "/v1/api_keys/{id}", "API keys", "getApiKey", "Read an API key", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("ApiKey")),
    errors: [404],
  }),
  op("patch", "/v1/api_keys/{id}", "API keys", "updateApiKey", "Update an API key", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.apiKeyUpdate },
    ...ok(ref("ApiKey")),
    errors: [404, 422],
  }),
  op("post", "/v1/api_keys/{id}/revoke", "API keys", "revokeApiKey", "Revoke an API key", {
    security: "backend",
    description: "Revoking is permanent; the optional `revocation_reason` is stored for the audit trail.",
    parameters: [idPath],
    body: { schema: body.revokeReason, required: false },
    ...ok(ref("ApiKey")),
    errors: [404, 422],
  }),
  op("delete", "/v1/api_keys/{id}", "API keys", "deleteApiKey", "Delete an API key", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "api_key" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),

  // self-service (Frontend API)
  op("get", "/v1/client/me/api_keys", "API keys", "listMyApiKeys", "List my API keys", {
    security: "frontend",
    parameters: backendListParams,
    success: { status: 200, schema: obj({ response: arr(ref("ApiKey")) }) },
    errors: [401, 429],
  }),
  op("post", "/v1/client/me/api_keys", "API keys", "createMyApiKey", "Create an API key for myself", {
    security: "frontend",
    description: "The subject is always the signed-in user; the secret is returned once.",
    body: { schema: body.apiKeyCreateFrontend },
    success: { status: 201, schema: obj({ response: ref("ApiKey") }) },
    errors: [401, 422],
  }),
  op("get", "/v1/client/me/api_keys/{id}", "API keys", "getMyApiKey", "Read one of my API keys", {
    security: "frontend",
    parameters: [idPath],
    success: { status: 200, schema: obj({ response: ref("ApiKey") }) },
    errors: [401, 404],
  }),
  op("patch", "/v1/client/me/api_keys/{id}", "API keys", "updateMyApiKey", "Update one of my API keys", {
    security: "frontend",
    parameters: [idPath],
    body: { schema: body.apiKeyUpdate },
    success: { status: 200, schema: obj({ response: ref("ApiKey") }) },
    errors: [401, 404, 422],
  }),
  op("post", "/v1/client/me/api_keys/{id}/revoke", "API keys", "revokeMyApiKey", "Revoke one of my API keys", {
    security: "frontend",
    parameters: [idPath],
    success: { status: 200, schema: obj({ response: ref("ApiKey") }) },
    errors: [401, 404],
  }),
  op("delete", "/v1/client/me/api_keys/{id}", "API keys", "deleteMyApiKey", "Delete one of my API keys", {
    security: "frontend",
    parameters: [idPath],
    success: { status: 200, schema: obj({ response: { type: "object", properties: { object: { const: "api_key" }, id: { type: "string" }, deleted: { const: true } } } }) },
    errors: [401, 404],
  }),
  op("get", "/v1/client/organizations/{orgId}/api_keys", "API keys", "listOrganizationApiKeys", "List an organization's API keys", {
    security: "frontend",
    description: "Requires `org:sys_api_keys:manage` or `org:sys_profile:manage` in the organization.",
    parameters: [{ name: "orgId", in: "path", schema: { type: "string" } }, ...backendListParams],
    success: { status: 200, schema: obj({ response: arr(ref("ApiKey")) }) },
    errors: [401, 403, 404],
  }),
  op("post", "/v1/client/organizations/{orgId}/api_keys", "API keys", "createOrganizationApiKey", "Create an organization API key", {
    security: "frontend",
    description: "Requires `org:sys_api_keys:manage` or `org:sys_profile:manage`. The subject is the organization; the secret is returned once.",
    parameters: [{ name: "orgId", in: "path", schema: { type: "string" } }],
    body: { schema: body.apiKeyCreateFrontend },
    success: { status: 201, schema: obj({ response: ref("ApiKey") }) },
    errors: [401, 403, 404, 422],
  }),
  op("get", "/v1/client/organizations/{orgId}/api_keys/{id}", "API keys", "getOrganizationApiKey", "Read an organization API key", {
    security: "frontend",
    parameters: [{ name: "orgId", in: "path", schema: { type: "string" } }, idPath],
    success: { status: 200, schema: obj({ response: ref("ApiKey") }) },
    errors: [401, 403, 404],
  }),
  op("patch", "/v1/client/organizations/{orgId}/api_keys/{id}", "API keys", "updateOrganizationApiKey", "Update an organization API key", {
    security: "frontend",
    parameters: [{ name: "orgId", in: "path", schema: { type: "string" } }, idPath],
    body: { schema: body.apiKeyUpdate },
    success: { status: 200, schema: obj({ response: ref("ApiKey") }) },
    errors: [401, 403, 404, 422],
  }),
  op("post", "/v1/client/organizations/{orgId}/api_keys/{id}/revoke", "API keys", "revokeOrganizationApiKey", "Revoke an organization API key", {
    security: "frontend",
    parameters: [{ name: "orgId", in: "path", schema: { type: "string" } }, idPath],
    success: { status: 200, schema: obj({ response: ref("ApiKey") }) },
    errors: [401, 403, 404],
  }),
  op("delete", "/v1/client/organizations/{orgId}/api_keys/{id}", "API keys", "deleteOrganizationApiKey", "Delete an organization API key", {
    security: "frontend",
    parameters: [{ name: "orgId", in: "path", schema: { type: "string" } }, idPath],
    success: { status: 200, schema: obj({ response: { type: "object", properties: { object: { const: "api_key" }, id: { type: "string" }, deleted: { const: true } } } }) },
    errors: [401, 403, 404],
  }),
];

export const m2mPaths: DocumentedOperation[] = [
  op("get", "/v1/m2m/machines", "M2M", "listMachines", "List machines", {
    security: "backend",
    parameters: backendListParams,
    ...list(ref("Machine")),
    errors: [429],
  }),
  op("post", "/v1/m2m/machines", "M2M", "createMachine", "Create a machine", {
    security: "backend",
    description: "The machine secret (`mk_…`) is returned once, in this response.",
    body: { schema: body.machineCreate },
    success: { status: 201, schema: { allOf: [ref("Machine")], additionalProperties: true, properties: { secret: { type: "string" } } } },
    errors: [422],
  }),
  op("get", "/v1/m2m/machines/{id}", "M2M", "getMachine", "Read a machine", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("Machine")),
    errors: [404],
  }),
  op("patch", "/v1/m2m/machines/{id}", "M2M", "updateMachine", "Update a machine", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.machineUpdate },
    ...ok(ref("Machine")),
    errors: [404, 422],
  }),
  op("delete", "/v1/m2m/machines/{id}", "M2M", "deleteMachine", "Delete a machine", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "machine" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),
  op("post", "/v1/m2m/machines/{id}/secret/rotate", "M2M", "rotateMachineSecret", "Rotate a machine secret", {
    security: "backend",
    description: "Returns the machine with the new `secret`. Tokens already issued with the old secret stay valid until they expire.",
    parameters: [idPath],
    success: { status: 200, schema: { allOf: [ref("Machine")], additionalProperties: true, properties: { secret: { type: "string" } } } },
    errors: [404],
  }),
  op("post", "/v1/m2m/machines/{id}/scopes", "M2M", "addMachineScope", "Grant a machine access to another machine", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.machineScope },
    ...ok(ref("Machine")),
    errors: [404, 422],
  }),
  op("get", "/v1/m2m/tokens", "M2M", "listMachineTokens", "List machine tokens", {
    security: "backend",
    description: "Filter with `machine_id`.",
    parameters: [...backendListParams, queryParam("machine_id", { type: "string" })],
    ...list(ref("MachineToken")),
    errors: [429],
  }),
  op("post", "/v1/m2m/tokens", "M2M", "createMachineToken", "Mint a machine token", {
    security: "backend",
    description:
      "Mints an opaque `mt_…` token or a JWT for a machine. Authenticate the machine with its `machine_secret` in the " +
      "body or an `mk_…` bearer token; the secret key gate already ran. The token is returned once.",
    body: { schema: body.machineTokenCreate },
    success: { status: 201, schema: ref("MachineToken") },
    errors: [401, 422, 429],
  }),
  op("post", "/v1/m2m/tokens/verify", "M2M", "verifyMachineToken", "Verify a machine token", {
    security: "backend",
    body: { schema: body.machineTokenVerify },
    success: { status: 200, schema: { allOf: [ref("MachineToken")], properties: { valid: { const: true }, machine: ref("Machine") } } },
    errors: [401, 422, 429],
  }),
  op("post", "/v1/m2m/tokens/{id}/revoke", "M2M", "revokeMachineToken", "Revoke a machine token", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("MachineToken")),
    errors: [404],
  }),
];
