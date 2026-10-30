/** Shared fixtures for the mail tests: an instance wired to the test outbox and a Backend API client. */
import { expect } from "vitest";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import { clearMailOutbox } from "../../src/services/mail";
import { testClient } from "./helpers";

export const SECRET = "sk_test_testsecret";
export const RESEND_KEY = "re_live_test_key_do_not_leak";

export async function instance(overrides: Parameters<typeof createContext>[0] = {}) {
  const ctx = await createContext({
    databaseUrl: ":memory:",
    secretKey: SECRET,
    baseUrl: "http://localhost:4000",
    nodeEnv: "test",
    ...overrides,
  });
  clearMailOutbox();
  const app = createApp(ctx);
  const api = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${SECRET}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ctx, app, api };
}

/** Verified user created through the Backend API, so sign-in flows do not need an email first. */
export async function verifiedUser(api: (method: string, path: string, body?: unknown) => Response | Promise<Response>, email: string) {
  const res = await api("POST", "/v1/users", { email_address: [email], password: "Sup3rSecret!" });
  if (res.status !== 200) throw new Error(`create user failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; email_addresses: { email_address: string; id: string }[] };
}

/** Runs an `email_code` first-factor sign-in and returns the completed session, using `readCode` for the delivered code. */
export async function signInWithEmailCode(app: ReturnType<typeof createApp>, email: string, readCode: () => string) {
  const client = testClient(app);
  const created = await client.json<{ response: { id: string; status: string } }>("/v1/client/sign_ins", { body: { identifier: email } });
  expect(created.response.status).toBe("needs_first_factor");
  await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_code" } });
  const code = readCode();
  expect(code).toMatch(/^\d{6}$/);
  const done = await client.json<{ response: { status: string; created_session_id: string } }>(
    `/v1/client/sign_ins/${created.response.id}/attempt_first_factor`,
    { body: { strategy: "email_code", code } },
  );
  expect(done.response.status).toBe("complete");
  return done.response.created_session_id;
}

export const pathOf = (link: string) => { const url = new URL(link); return `${url.pathname}${url.search}`; };
