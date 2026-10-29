import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExpressNext, ExpressRequest, ExpressResponse } from "../../src/adapters/express";

/**
 * Every handler has the Express shape, so inline `(req, res) => …` functions get contextual types.
 * A handler taking `next` is treated as middleware, exactly like Express.
 */
export type RouteHandler = (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => unknown;

interface Layer {
  method: string;
  path: string;
  handlers: RouteHandler[];
}

/** A tiny Express-shaped router over `node:http`: middleware chain, `req.auth`, `res.status().json()`. */
export class MiniApp {
  private readonly layers: Layer[] = [];
  private server: Server | null = null;
  url = "";

  use(method: string, path: string, ...handlers: RouteHandler[]): this {
    this.layers.push({ method: method.toUpperCase(), path, handlers });
    return this;
  }

  get(path: string, ...handlers: RouteHandler[]): this {
    return this.use("GET", path, ...handlers);
  }

  post(path: string, ...handlers: RouteHandler[]): this {
    return this.use("POST", path, ...handlers);
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
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);

    const url = incoming.url ?? "/";
    const path = url.split("?")[0]!;
    const matched = this.layers.filter((layer) => layer.method === incoming.method && (layer.path === "*" || layer.path === path));

    const req = {
      method: incoming.method,
      url,
      originalUrl: url,
      headers: incoming.headers as Record<string, string | string[] | undefined>,
      body: raw.length ? raw : undefined,
      auth: undefined as ExpressRequest["auth"],
    } as ExpressRequest;

    const res = makeResponse(outgoing);
    const next: ExpressNext = () => undefined;

    try {
      for (const layer of matched) {
        for (const handler of layer.handlers) {
          if (handler.length >= 3) {
            let advanced = false;
            await new Promise<void>((resolve, reject) => {
              const result = handler(req, res, (error?: unknown) => {
                advanced = true;
                if (error) reject(error);
                else resolve();
              });
              if (result && typeof (result as Promise<void>).then === "function") {
                (result as Promise<void>).then(() => { if (!advanced) resolve(); }, reject);
              }
            });
            if (!advanced) break; // middleware ended the chain
          } else {
            await handler(req, res, next);
          }
          if (outgoing.writableEnded) return;
        }
      }
      if (!outgoing.writableEnded) res.status(404).json({ errors: [{ code: "resource_not_found", message: "Route not found" }] });
    } catch {
      if (!outgoing.writableEnded) res.status(500).json({ errors: [{ code: "internal_server_error", message: "Internal server error" }] });
    }
  }
}

function makeResponse(outgoing: ServerResponse): ExpressResponse {
  let status = 200;
  const response: ExpressResponse = {
    status(code: number) {
      status = code;
      return response;
    },
    json(body: unknown) {
      const payload = JSON.stringify(body);
      if (!outgoing.headersSent) outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(payload);
      return response;
    },
    setHeader(name: string, value: string) {
      if (!outgoing.headersSent) outgoing.setHeader(name, value);
      return response;
    },
  };
  return response;
}

export interface HttpResult {
  status: number;
  body: unknown;
  headers: Headers;
  text: string;
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
  return { status: response.status, body, headers: response.headers, text };
}
