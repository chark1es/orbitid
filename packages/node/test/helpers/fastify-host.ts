import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstanceLike, FastifyReplyLike, FastifyRequestLike } from "../../src/adapters/fastify";

type Hook = (request: FastifyRequestLike, reply: FastifyReplyLike, done: (error?: Error) => void) => void;
type Handler = (request: FastifyRequestLike, reply: FastifyReplyLike) => unknown;

/**
 * A Fastify-shaped host on a real `node:http` server: `decorateRequest`, `addHook("preHandler")`,
 * `reply.code().header().send()`. The SDK plugin and route hooks are exercised unmodified.
 */
export class FastifyHttpServer {
  private readonly decorations = new Map<string, unknown>();
  private readonly hooks: Hook[] = [];
  private readonly routes = new Map<string, Handler>();
  private server: Server | null = null;
  url = "";

  readonly instance: FastifyInstanceLike = {
    decorateRequest: (name: string, value: unknown) => {
      this.decorations.set(name, value);
      return this.instance;
    },
    addHook: (name: "onRequest" | "preHandler", hook: Hook) => {
      if (name !== "preHandler") throw new Error(`unexpected hook ${name}`);
      this.hooks.push(hook);
      return this.instance;
    },
  };

  /** `route("/me", [preHandler], handler)` mirrors `app.get(path, { preHandler }, handler)`. */
  route(path: string, preHandlers: Hook[], handler: Handler): this {
    this.routes.set(path, handler);
    if (preHandlers.length) this.hooks.push(...preHandlers);
    return this;
  }

  async listen(): Promise<this> {
    const server = createServer((incoming, outgoing) => {
      void this.dispatch(incoming, outgoing);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  private async dispatch(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    for await (const _chunk of incoming) void _chunk;
    const path = (incoming.url ?? "/").split("?")[0]!;
    const handler = this.routes.get(path);

    const request: FastifyRequestLike = { headers: incoming.headers as Record<string, string | string[] | undefined> };
    for (const [name, value] of this.decorations) (request as unknown as Record<string, unknown>)[name] = value;

    let settled: { status: number; body: unknown; headers: Record<string, string> } | null = null;
    let notify: (() => void) | null = null;

    const reply: FastifyReplyLike = {
      code(statusCode: number) {
        settled = { status: statusCode, body: undefined, headers: settled?.headers ?? {} };
        return reply;
      },
      header(name: string, value: string) {
        settled = { status: settled?.status ?? 200, body: settled?.body, headers: { ...(settled?.headers ?? {}), [name]: value } };
        return reply;
      },
      send(payload?: unknown) {
        settled = { status: settled?.status ?? 200, body: payload, headers: settled?.headers ?? {} };
        notify?.();
        return reply;
      },
    };

    const runHooks = async (): Promise<boolean> => {
      for (const hook of this.hooks) {
        let advanced = false;
        const answered = new Promise<void>((resolve) => { notify = resolve; });
        await new Promise<void>((resolve) => {
          hook(request, reply, () => {
            advanced = true;
            resolve();
          });
          void answered.then(resolve);
        });
        if (!advanced) return false;
      }
      return true;
    };

    const proceed = await runHooks();
    if (proceed && handler) await handler(request, reply);
    if (!handler && !settled) settled = { status: 404, body: { errors: [{ code: "resource_not_found", message: "Route not found" }] }, headers: {} };

    const result = settled as { status: number; body: unknown; headers: Record<string, string> } | null;
    if (outgoing.writableEnded) return;
    if (!result) {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ errors: [{ code: "internal_server_error", message: "Internal server error" }] }));
      return;
    }
    outgoing.writeHead(result.status, { "content-type": "application/json", ...result.headers });
    outgoing.end(result.body === undefined ? "" : JSON.stringify(result.body));
  }
}

export interface HttpResult {
  status: number;
  body: unknown;
  headers: Headers;
}

export async function http(url: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}
