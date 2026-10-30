/** Shared fixtures for the second-factor, trusted-device and anonymous-account tests. */
import { authenticator } from "otplib";
import { testClient, type TestClient, type setup } from "./helpers";

export const TRUSTED_COOKIE = "__orbit_trusted";

/** Reads one cookie the client jar holds (the jar is exposed through the request headers). */
export function cookieValue(client: TestClient, name: string): string | undefined {
  const header = client.cookie ?? "";
  for (const part of header.split(/;\s*/)) {
    const [key, ...rest] = part.split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export async function enableEmailSecondFactor(ctx: Awaited<ReturnType<typeof setup>>["ctx"]) {
  await ctx.settings.update({
    attributes: {
      emailAddress: { enabled: true, required: true, usedForFirstFactor: true, usedForSecondFactor: true, verifications: ["email_code"], verifyAtSignUp: true },
    },
  });
}

export async function enableTotp(client: TestClient): Promise<string> {
  const created = await client.json<{ response: { secret: string } }>("/v1/client/me/totp", { body: {} });
  const code = authenticator.generate(created.response.secret);
  await client.json("/v1/client/me/totp/attempt_verification", { body: { code } });
  return created.response.secret;
}

/** Sign-in up to `needs_second_factor`. */
export async function startSignIn(app: Awaited<ReturnType<typeof setup>>["app"], email: string, password: string) {
  const client = testClient(app);
  const created = await client.json<{
    response: { id: string; status: string; supported_second_factors: { strategy: string; email_address_id?: string }[] };
  }>("/v1/client/sign_ins", { body: { identifier: email, password } });
  return { client, id: created.response.id, secondFactors: created.response.supported_second_factors };
}
