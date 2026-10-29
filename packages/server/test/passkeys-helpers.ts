// Helpers for the end-to-end passkey tests: drive the real HTTP API with a software authenticator.
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { first } from "../src/lib/db";
import type { AppContext } from "../src/context";
import type { TestClient } from "./core/helpers";
import { VirtualAuthenticator, type VirtualAuthenticatorOptions } from "./support/virtual-authenticator";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

/** The app origin the tests claim to come from; also the instance `application.homeUrl` default. */
export const APP_ORIGIN = "http://localhost:3000";
export const APP_RP_ID = "localhost";

export async function enablePasskeys(ctx: AppContext, extra: Record<string, unknown> = {}) {
  await ctx.settings.update({ attributes: { passkey: { enabled: true, usedForFirstFactor: true } }, ...extra });
}

export interface BeginRegistrationResponse {
  response: {
    id: string;
    name: string;
    verification: { status: string; strategy: string; nonce: string | null };
    public_key_credential_creation_options: PublicKeyCredentialCreationOptionsJSON;
  };
}

/** `POST /me/passkeys` */
export function beginRegistration(client: TestClient, body: Record<string, unknown> = {}, origin = APP_ORIGIN) {
  return client.json<BeginRegistrationResponse>("/v1/client/me/passkeys", { body, headers: { origin } });
}

export function newAuthenticator(options: Partial<VirtualAuthenticatorOptions> = {}) {
  return new VirtualAuthenticator({ rpID: APP_RP_ID, origin: APP_ORIGIN, ...options });
}

/** Full ceremony over HTTP: begin → create credential → finish. Returns the stored row + authenticator. */
export async function registerPasskey(
  client: TestClient,
  options: { name?: string; authenticator?: VirtualAuthenticator; origin?: string; body?: Record<string, unknown> } = {},
) {
  const authenticator = options.authenticator ?? newAuthenticator();
  const origin = options.origin ?? APP_ORIGIN;
  const begin = await beginRegistration(client, { ...(options.name ? { name: options.name } : {}), ...options.body }, origin);
  const credential = authenticator.register(begin.response.public_key_credential_creation_options);
  const finished = await client.json<{ response: { object: string; id: string; name: string; created_at: number } }>(
    `/v1/client/me/passkeys/${begin.response.id}/attempt_verification`,
    { body: { public_key_credential: credential }, headers: { origin } },
  );
  return { begin, credential, finished, authenticator, passkeyId: begin.response.id };
}

export async function passkeyRow(ctx: AppContext, id: string) {
  return first(await ctx.db.select().from(schema.passkeys).where(eq(schema.passkeys.id, id)));
}

export interface SignInEnvelope {
  response: {
    id: string;
    status: string;
    created_session_id: string | null;
    first_factor_verification: { strategy: string; status: string; nonce: string | null } | null;
    supported_first_factors: { strategy: string }[] | null;
    supported_second_factors: { strategy: string }[] | null;
    sign_in?: unknown;
  };
  client?: { sign_in: { id: string; status: string; created_session_id: string | null } | null };
}

/** `POST /sign_ins` */
export function createSignIn(client: TestClient, body: Record<string, unknown> = {}, origin = APP_ORIGIN) {
  return client.json<SignInEnvelope>("/v1/client/sign_ins", { body, headers: { origin } });
}

export type RequestOptionsJSON = PublicKeyCredentialRequestOptionsJSON;

/** `POST /sign_ins/:id/prepare_first_factor` and the WebAuthn request options it hands the browser. */
export async function preparePasskey(client: TestClient, signInId: string, origin = APP_ORIGIN) {
  const prepared = await client.json<SignInEnvelope>(`/v1/client/sign_ins/${signInId}/prepare_first_factor`, {
    body: { strategy: "passkey" },
    headers: { origin },
  });
  const nonce = prepared.response.first_factor_verification?.nonce;
  if (!nonce) throw new Error("prepare_first_factor did not return WebAuthn request options");
  return { prepared, options: JSON.parse(nonce) as RequestOptionsJSON };
}

export function attemptPasskey(
  client: TestClient,
  signInId: string,
  credential: unknown,
  origin = APP_ORIGIN,
) {
  return client.request(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
    body: { strategy: "passkey", public_key_credential: credential },
    headers: { origin },
  });
}

/** Discoverable (identifier-less) passkey sign-in. */
export async function signInWithPasskey(
  client: TestClient,
  authenticator: VirtualAuthenticator,
  options: { origin?: string; overrides?: Parameters<VirtualAuthenticator["authenticate"]>[1] } = {},
) {
  const origin = options.origin ?? APP_ORIGIN;
  const created = await createSignIn(client, { strategy: "passkey" }, origin);
  const { options: requestOptions } = await preparePasskey(client, created.response.id, origin);
  const assertion = authenticator.authenticate(requestOptions, options.overrides);
  const res = await attemptPasskey(client, created.response.id, assertion, origin);
  return { signInId: created.response.id, requestOptions, assertion, res };
}

/** Identifier-first passkey sign-in. */
export async function signInWithPasskeyForIdentifier(
  client: TestClient,
  identifier: string,
  authenticator: VirtualAuthenticator,
  options: { origin?: string; overrides?: Parameters<VirtualAuthenticator["authenticate"]>[1] } = {},
) {
  const origin = options.origin ?? APP_ORIGIN;
  const created = await createSignIn(client, { identifier, strategy: "passkey" }, origin);
  const { options: requestOptions } = await preparePasskey(client, created.response.id, origin);
  const assertion = authenticator.authenticate(requestOptions, options.overrides);
  const res = await attemptPasskey(client, created.response.id, assertion, origin);
  return { signInId: created.response.id, requestOptions, assertion, res };
}

export async function sessionRow(ctx: AppContext, id: string) {
  return first(await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)));
}
