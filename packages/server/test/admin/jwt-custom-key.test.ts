import { describe, expect, it } from "vitest";
import { createLocalJWKSet, importJWK, jwtVerify, decodeProtectedHeader, type JWK } from "jose";
import type { JwtTemplateJSON } from "@orbitid/shared";
import { getJwks } from "../../src/services/tokens";
import { createSessionFixture, createUser, json, sessionJwtFor, testApp } from "./helpers";

async function mint(algorithm: "HS256" | "RS256") {
  const { api, ctx } = await testApp();
  const user = await createUser(api, { email_address: ["ada@example.com"] });
  const { sessionId } = await createSessionFixture(ctx, user.id);
  const template = await json<JwtTemplateJSON>(
    await api("POST", "/v1/jwt_templates", { name: "partner", claims: { email: "{{user.primary_email_address}}" }, custom_signing_key: true, signing_algorithm: algorithm }),
  );
  const proof = await sessionJwtFor(ctx, sessionId, user.id);
  const { jwt } = await json<{ jwt: string }>(await api("POST", `/v1/sessions/${sessionId}/tokens/partner`, undefined, { "x-orbitid-session-token": proof }));
  return { ctx, jwt, template, userId: user.id };
}

describe("JWT templates with a custom signing key", () => {
  it("signs HS256 tokens with the template secret, not the instance key", async () => {
    const { ctx, jwt, template, userId } = await mint("HS256");
    expect(typeof template.signing_key).toBe("string");
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "HS256", typ: "JWT" });

    const { payload } = await jwtVerify(jwt, new TextEncoder().encode(template.signing_key as string));
    expect(payload.sub).toBe(userId);
    expect(payload.email).toBe("ada@example.com");
    await expect(jwtVerify(jwt, createLocalJWKSet(await getJwks(ctx)))).rejects.toThrow();
  });

  it("signs RS256 tokens verifiable with the exposed public JWK only", async () => {
    const { jwt, template } = await mint("RS256");
    const publicJwk = template.signing_key as unknown as JWK;
    expect(publicJwk.kty).toBe("RSA");
    expect(publicJwk.d).toBeUndefined();

    const { payload } = await jwtVerify(jwt, await importJWK(publicJwk, "RS256"));
    expect(payload.email).toBe("ada@example.com");
  });
});
