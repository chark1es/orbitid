import type { OrbitInstance, SignInApi, SignUpApi } from "../w6";
import {
  normalizeClient,
  normalizeSession,
  normalizeSignIn,
  normalizeSignUp,
  type NormalizedClient,
  type NormalizedSession,
} from "../normalize";
import type { SignInResource, SignUpResource } from "../types";
import { isRecord } from "../guards";

export function unwrap(value: unknown): unknown {
  if (isRecord(value)) {
    if ("response" in value && value.response !== undefined) return unwrap(value.response);
    if ("sign_in" in value && value.sign_in !== undefined) return unwrap(value.sign_in);
    if ("signIn" in value && value.signIn !== undefined) return unwrap(value.signIn);
    if ("sign_up" in value && value.sign_up !== undefined) return unwrap(value.sign_up);
    if ("signUp" in value && value.signUp !== undefined) return unwrap(value.signUp);
  }
  return value;
}

function clientOf(orbit: OrbitInstance): NormalizedClient | null {
  return normalizeClient(orbit.client);
}

export function currentClient(orbit: OrbitInstance): NormalizedClient | null {
  return normalizeClient(orbit.client);
}

export function currentSession(orbit: OrbitInstance): NormalizedSession | null {
  return normalizeSession(orbit.session);
}

function clientSignIn(orbit: OrbitInstance): SignInResource | null {
  return clientOf(orbit)?.sign_in ?? null;
}

function clientSignUp(orbit: OrbitInstance): SignUpResource | null {
  return clientOf(orbit)?.sign_up ?? null;
}

export function pickSignIn(orbit: OrbitInstance, result: unknown): SignInResource | null {
  const unwrapped = unwrap(result);
  if (isRecord(unwrapped) && typeof unwrapped.status === "string" && "id" in unwrapped) {
    return normalizeSignIn(unwrapped);
  }
  return clientSignIn(orbit);
}

export function pickSignUp(orbit: OrbitInstance, result: unknown): SignUpResource | null {
  const unwrapped = unwrap(result);
  if (isRecord(unwrapped) && typeof unwrapped.status === "string" && "id" in unwrapped) {
    return normalizeSignUp(unwrapped);
  }
  return clientSignUp(orbit);
}

export function pickSessionId(orbit: OrbitInstance, result?: unknown): string | null {
  const unwrapped = unwrap(result);
  if (isRecord(unwrapped) && typeof unwrapped.created_session_id === "string") {
    return unwrapped.created_session_id;
  }
  const signIn = clientSignIn(orbit);
  if (signIn?.created_session_id) return signIn.created_session_id;
  const signUp = clientSignUp(orbit);
  return signUp?.created_session_id ?? null;
}

export function signInTarget(orbit: OrbitInstance): SignInApi | unknown {
  if (isRecord(orbit.signIn)) return orbit.signIn;
  const client = clientOf(orbit);
  if (client) {
    const camel: unknown = Reflect.get(client, "signIn");
    if (isRecord(camel)) return camel;
    const snake: unknown = client.sign_in;
    if (isRecord(snake) && typeof snake.create === "function") return snake;
  }
  return orbit;
}

export function signUpTarget(orbit: OrbitInstance): SignUpApi | unknown {
  if (isRecord(orbit.signUp)) return orbit.signUp;
  const client = clientOf(orbit);
  if (client) {
    const camel: unknown = Reflect.get(client, "signUp");
    if (isRecord(camel)) return camel;
    const snake: unknown = client.sign_up;
    if (isRecord(snake) && typeof snake.create === "function") return snake;
  }
  return orbit;
}
