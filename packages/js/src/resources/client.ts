import type { ClientJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import type { TokenCache } from "../token-cache";
import { Session } from "./session";
import { SignIn } from "./sign-in";
import { SignUp } from "./sign-up";

export class Client {
  readonly object = "client" as const;
  id: string;
  sessions: Session[];
  signIn: SignIn | null;
  signUp: SignUp | null;
  lastActiveSessionId: string | null;
  cookieExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: ClientJSON,
    private readonly tokenCache?: TokenCache,
  ) {
    this.id = json.id;
    this.sessions = (json.sessions ?? []).map((session) => Session.fromJSON(fapi, session, tokenCache));
    this.signIn = json.sign_in ? SignIn.fromJSON(fapi, json.sign_in) : null;
    this.signUp = json.sign_up ? SignUp.fromJSON(fapi, json.sign_up) : null;
    this.lastActiveSessionId = json.last_active_session_id;
    this.cookieExpiresAt = json.cookie_expires_at;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: ClientJSON, tokenCache?: TokenCache): Client {
    return new Client(fapi, json, tokenCache);
  }

  get activeSessions(): Session[] {
    return this.sessions.filter((session) => session.status === "active");
  }

  /** The session the user last activated (`client.session`); null until `setActive`. */
  get session(): Session | null {
    return this.sessions.find((session) => session.id === this.lastActiveSessionId) ?? null;
  }
}
