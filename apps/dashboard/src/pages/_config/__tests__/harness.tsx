import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { defaultInstanceSettings, type InstanceSettings } from "@orbitid/shared";

export interface ApiCall {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** Default settings with masked secrets, the shape `GET /v1/instance` returns. */
export function instanceBody(mutate?: (settings: InstanceSettings) => void): Record<string, unknown> {
  const settings = defaultInstanceSettings();
  settings.application.homeUrl = "http://localhost:3000";
  settings.email.from = "OrbitID <no-reply@example.com>";
  mutate?.(settings);
  return settings as unknown as Record<string, unknown>;
}

export interface MockApiOptions {
  instance?: unknown;
  environment?: unknown;
  health?: unknown;
  /** Status and body for `POST /v1/instance/email_test`; defaults to success. */
  emailTest?: { status: number; body: unknown };
  /** Extra handler for paths the page calls outside the settings API. */
  handle?: (call: ApiCall) => Response | undefined;
}

/**
 * Backend API stand-in for a settings or Connect page: answers `/v1/instance`, the public
 * `/health` and `/v1/client/environment`, and records every call for assertions.
 */
export function mockApi(options: MockApiOptions = {}): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: ApiCall = { method, url, body };
    calls.push(call);

    const handled = options.handle?.(call);
    if (handled) return handled;

    if (url.endsWith("/health")) {
      return json(options.health ?? { status: "ok", publishable_key: "pk_test_demo", database: "postgres" });
    }
    if (url.includes("/v1/client/environment")) {
      return json(
        options.environment ?? {
          auth_config: { first_factors: ["email_code", "password"], sign_up_mode: "public" },
          display_config: { application_name: "OrbitID App" },
        },
      );
    }
    if (url.endsWith("/v1/instance/email_test") && method === "POST") {
      return options.emailTest
        ? json(options.emailTest.body, options.emailTest.status)
        : json({ provider: "resend", ok: true });
    }
    if (url.includes("/v1/instance")) {
      if (method === "PATCH") return json({});
      return json(options.instance ?? instanceBody());
    }
    return json({ data: [], total_count: 0 });
  });
  return calls;
}

export function renderPage(ui: ReactElement, options: { secretKey?: string | null } = {}) {
  sessionStorage.setItem("orbitid.apiUrl", "http://localhost:4000");
  const secretKey = options.secretKey === undefined ? "sk_test_dashboard_session" : options.secretKey;
  if (secretKey) sessionStorage.setItem("orbitid.secretKey", secretKey);
  else sessionStorage.removeItem("orbitid.secretKey");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A controllable clipboard stub; jsdom has none. */
export function clipboardStub(): string[] {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        written.push(value);
      },
    },
  });
  return written;
}
