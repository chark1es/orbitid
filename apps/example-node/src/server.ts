import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { WebhookEvent } from "@orbitid/node";
import { orbit, PERMISSION_LIST_USERS } from "./orbit.js";

const PORT = Number(process.env.PORT ?? 3001);
/** Cap the body so a large upload cannot exhaust memory; webhook payloads are small. */
const MAX_BODY_BYTES = 256 * 1024;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "private, no-store",
    ...headers,
  });
  res.end(payload);
}

function apiError(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { errors: [{ code, message }] }, status === 401 ? { "www-authenticate": 'Bearer realm="orbitid"' } : {});
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function handleMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await orbit.authenticate(req);
  if (!auth) {
    apiError(res, 401, "authentication_invalid", "Authentication required");
    return;
  }
  json(res, 200, {
    userId: auth.userId,
    sessionId: auth.sessionId,
    orgId: auth.orgId,
    orgRole: auth.orgRole,
    orgPermissions: auth.orgPermissions,
  });
}

/** A permission-protected route, using the same `has()` the framework adapters call. */
async function handleAdminUsers(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await orbit.authenticate(req);
  if (!auth) {
    apiError(res, 401, "authentication_invalid", "Authentication required");
    return;
  }
  if (!auth.has({ permission: PERMISSION_LIST_USERS })) {
    apiError(res, 403, "org_permission_required", `You do not have permission to perform this action. Missing permission: ${PERMISSION_LIST_USERS}`);
    return;
  }
  const users = await orbit.client.users.getUserList({ limit: 20, orderBy: "-created_at" });
  json(res, 200, {
    totalCount: users.totalCount,
    users: users.data.map((user) => ({
      id: user.id,
      primaryEmailAddress: user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ?? null,
      createdAt: user.createdAt,
    })),
  });
}

/** Collects the raw bytes first: the signature covers exactly what the server sent. */
async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let event: WebhookEvent;
  try {
    event = await orbit.webhooks.verify(raw, req.headers);
  } catch {
    // Signature, timestamp or payload was wrong; never echo the reason to the sender.
    apiError(res, 400, "webhook_verification_failed", "The webhook payload could not be verified");
    return;
  }

  switch (event.type) {
    case "user.created":
      console.log("new user", (event.data as { id?: string })?.id);
      break;
    case "session.revoked":
      console.log("session revoked", (event.data as { id?: string })?.id);
      break;
    default:
      console.log("event", event.type);
  }
  json(res, 200, { received: true });
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const route = `${req.method} ${path}`;

  const run = async (): Promise<void> => {
    switch (route) {
      case "GET /":
        json(res, 200, { service: "example-node", signedIn: (await orbit.authenticate(req)) !== null });
        return;
      case "GET /me":
        return handleMe(req, res);
      case "GET /admin/users":
        return handleAdminUsers(req, res);
      case "POST /api/webhooks":
        return handleWebhook(req, res);
      default:
        apiError(res, 404, "resource_not_found", "Route not found");
    }
  };

  void run().catch((error: unknown) => {
    // Log the failure server-side; the caller only learns that something went wrong.
    console.error("[example-node]", error);
    if (!res.headersSent) apiError(res, 500, "internal_server_error", "Internal server error");
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`example-node listening on http://localhost:${PORT}`);
  console.log(`OrbitID server: ${orbit.config.apiUrl}`);
  console.log(`JWKS:           ${orbit.config.jwksUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
