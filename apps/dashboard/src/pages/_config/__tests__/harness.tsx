import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { defaultInstanceSettings, type InstanceSettings } from "@orbitid/shared";
import { AuthProvider } from "../../../lib/auth";

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
  settings.email.provider = "resend";
  settings.email.resendApiKey = "••••";
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
  /** Whether `GET /v1/operator_sessions/current` reports a live session. Defaults to true. */
  sessionActive?: boolean;
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
    if (url.includes("/v1/operator_sessions/current")) {
      return options.sessionActive === false
        ? json({ errors: [{ code: "authentication_invalid", message: "Your dashboard session ended. Sign in again." }] }, 401)
        : json({ object: "operator_session", id: "osess_test", expires_at: Date.now() + 3_600_000 });
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

export function renderPage(ui: ReactElement) {
  sessionStorage.setItem("orbitid.apiUrl", "http://localhost:4000");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Wraps a page in `AuthProvider` for pages that read the session (Connect, UserMenu). */
export function renderAuthedPage(ui: ReactElement) {
  sessionStorage.setItem("orbitid.apiUrl", "http://localhost:4000");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
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
