import { isRecord } from "../guards";
import type { SignInResource, SignUpResource } from "../types";
import { type Cached, cached, read, str, bool, num, list, view, define, bindMethods } from "./utils";
import { normalizeSignIn, normalizeSignUp } from "./sign-flow";

// ---------- client / sessions ----------

export interface NormalizedSession {
  id: string;
  status: string;
  public_user_data: {
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string;
    has_image?: boolean;
    identifier?: string;
    user_id?: string;
  } | null;
  latest_activity: {
    browser_name?: string;
    device_type?: string;
    city?: string | null;
    country?: string | null;
    ip_address?: string;
  } | null;
  last_active_at: number | null;
  expire_at?: number;
  [key: string]: unknown;
}

const sessionCache = new WeakMap<object, Cached<NormalizedSession>>();

export function normalizeSession(raw: unknown): NormalizedSession | null {
  if (!isRecord(raw)) return null;
  return cached(sessionCache, raw, () => {
    const target = view(raw) as NormalizedSession;
    const publicUser = read(raw, "public_user_data", "publicUserData");
    const activity = read(raw, "latest_activity", "latestActivity");
    define(target, {
      id: str(raw, "id") ?? "",
      status: str(raw, "status") ?? "active",
      public_user_data: isRecord(publicUser)
        ? {
            user_id: str(publicUser, "user_id", "userId") ?? undefined,
            first_name: str(publicUser, "first_name", "firstName"),
            last_name: str(publicUser, "last_name", "lastName"),
            image_url: str(publicUser, "image_url", "imageUrl") ?? undefined,
            has_image: bool(publicUser, "has_image", "hasImage"),
            identifier: str(publicUser, "identifier") ?? undefined,
          }
        : null,
      latest_activity: isRecord(activity)
        ? {
            browser_name: str(activity, "browser_name", "browserName") ?? undefined,
            device_type: str(activity, "device_type", "deviceType") ?? undefined,
            city: str(activity, "city"),
            country: str(activity, "country"),
            ip_address: str(activity, "ip_address", "ipAddress") ?? undefined,
          }
        : null,
      last_active_at: num(raw, "last_active_at", "lastActiveAt"),
      expire_at: num(raw, "expire_at", "expireAt") ?? undefined,
    });
    bindMethods(target, raw, ["revoke", "end", "remove", "touch", "getToken"]);
    return target;
  });
}

export interface NormalizedClient {
  id: string;
  sessions: NormalizedSession[];
  sign_in: SignInResource | null;
  sign_up: SignUpResource | null;
  last_active_session_id: string | null;
}

const clientCache = new WeakMap<object, Cached<NormalizedClient>>();

export function normalizeClient(raw: unknown): NormalizedClient | null {
  if (!isRecord(raw)) return null;
  return cached(clientCache, raw, () => ({
    id: str(raw, "id") ?? "",
    sessions: list<unknown>(raw.sessions)
      .map(normalizeSession)
      .filter((session): session is NormalizedSession => session !== null),
    sign_in: normalizeSignIn(read(raw, "sign_in", "signIn")),
    sign_up: normalizeSignUp(read(raw, "sign_up", "signUp")),
    last_active_session_id: str(raw, "last_active_session_id", "lastActiveSessionId"),
  }));
}
