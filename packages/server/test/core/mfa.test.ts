import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { getSmsOutbox } from "../../src/services/mail";
import { errorsOf, setup, signUpUser, testClient, type TestClient } from "./helpers";

interface TotpSetup { response: { verified: boolean; secret: string; uri: string; qr_code: string; backup_codes?: { code: string }[] } }

async function enableTotp(client: TestClient) {
  const setupResponse = await client.json<TotpSetup>("/v1/client/me/totp", { body: {} });
  expect(setupResponse.response.uri).toMatch(/^otpauth:\/\/totp\//);
  expect(setupResponse.response.qr_code).toMatch(/^data:image\/png;base64,/);
  const code = authenticator.generate(setupResponse.response.secret);
  const verified = await client.json<TotpSetup>("/v1/client/me/totp/attempt_verification", { body: { code } });
  expect(verified.response.verified).toBe(true);
  expect(verified.response.backup_codes).toHaveLength(10);
  return { secret: setupResponse.response.secret, backupCodes: verified.response.backup_codes!.map((c) => c.code) };
}

describe("MFA", () => {
  it("enrolls TOTP, keeps the secret encrypted and requires it at sign-in", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const { secret } = await enableTotp(user.client);

    const stored = ctx.db.select().from(schema.users).where(eq(schema.users.id, user.userId)).get()!;
    expect(stored.totpVerified).toBe(true);
    expect(stored.totpSecretEnc).not.toContain(secret);
    expect(stored.totpSecretEnc).toMatch(/^v1\./);
    expect(stored.backupCodes?.length).toBe(10);

    const client = testClient(app);
    const created = await client.json<{ response: { id: string; status: string; supported_second_factors: { strategy: string }[] } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(created.response.status).toBe("needs_second_factor");
    expect(created.response.supported_second_factors.map((f) => f.strategy)).toEqual(expect.arrayContaining(["totp", "backup_code"]));

    const bad = await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "totp", code: "000000" },
    });
    expect(errorsOf(bad)[0]?.code).toBe("form_code_incorrect");

    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, { body: { strategy: "totp" } });
    const done = await client.json<{ response: { status: string; created_session_id: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "totp", code: authenticator.generate(secret) },
    });
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);
  });

  it("refuses a second factor before the first factor is verified", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: { identifier: user.email } });
    const res = await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "totp", code: "123456" },
    });
    expect(errorsOf(res)[0]?.code).toBe("client_state_invalid");
  });

  it("uses a verified phone number as a second factor", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({
      attributes: { phoneNumber: { enabled: true, usedForFirstFactor: true, usedForSecondFactor: true, verifications: ["phone_code"] } },
    });
    const user = await signUpUser(app);
    const phone = await user.client.json<{ response: { id: string } }>("/v1/client/me/phone_numbers", {
      body: { phone_number: "+15550001111" },
    });
    expect(phone.response.id).toMatch(/^idn_p_/);
    await user.client.json(`/v1/client/me/phone_numbers/${phone.response.id}/prepare_verification`, { body: {} });
    const setupCode = /(\d{6})/.exec(getSmsOutbox().at(-1)!.body)?.[1];
    await user.client.json(`/v1/client/me/phone_numbers/${phone.response.id}/attempt_verification`, { body: { code: setupCode } });
    await user.client.json(`/v1/client/me/phone_numbers/${phone.response.id}`, {
      method: "PATCH",
      body: { reserved_for_second_factor: true, default_second_factor: true },
    });

    const client = testClient(app);
    const created = await client.json<{ response: { id: string; status: string; supported_second_factors: { strategy: string }[] } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(created.response.status).toBe("needs_second_factor");
    expect(created.response.supported_second_factors.some((f) => f.strategy === "phone_code")).toBe(true);
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, { body: { strategy: "phone_code" } });
    const sms = getSmsOutbox().at(-1)!;
    expect(sms.to).toBe("+15550001111");
    const code = /(\d{6})/.exec(sms.body)?.[1];
    const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "phone_code", code },
    });
    expect(done.response.status).toBe("complete");
  });

  it("signs in with a single-use backup code", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const { backupCodes } = await enableTotp(user.client);
    const code = backupCodes[0]!;

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_second_factor`, { body: { strategy: "backup_code" } });
    const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_second_factor`, {
      body: { strategy: "backup_code", code },
    });
    expect(done.response.status).toBe("complete");

    // The same code cannot be reused.
    const other = testClient(app);
    const created2 = await other.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    const reused = await other.json(`/v1/client/sign_ins/${created2.response.id}/attempt_second_factor`, {
      body: { strategy: "backup_code", code },
    });
    expect(errorsOf(reused)[0]?.code).toBe("form_code_incorrect");
  });

  it("regenerates backup codes and disables TOTP", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    await enableTotp(user.client);

    const regenerated = await user.client.json<{ response: { code: string }[] }>("/v1/client/me/backup_codes", { body: {} });
    expect(regenerated.response).toHaveLength(10);

    const disabled = await user.client.json<{ response: { verified: boolean } }>("/v1/client/me/totp", { method: "DELETE" });
    expect(disabled.response.verified).toBe(false);

    const client = testClient(app);
    const plain = await client.json<{ response: { status: string; created_session_id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(plain.response.status).toBe("complete");
  });
});
