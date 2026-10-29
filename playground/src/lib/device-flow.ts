/**
 * Device authorization grant helpers for the test site: the shape of the code response, how a poll
 * answer is read, and the dev-server memory that keeps the device code off the page.
 */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowRecord extends DeviceAuthorization {
  /** OAuth application the code was issued for. */
  applicationId: string;
  clientId: string;
  applicationName: string;
  scopes: string;
  startedAt: number;
  /** Every poll answer, newest last, so the page can show the whole exchange. */
  polls: DevicePoll[];
}

export interface DevicePoll {
  at: number;
  state: DevicePollState;
  message: string;
}

export type DevicePollState = "pending" | "slow-down" | "denied" | "expired" | "complete" | "failed";

export interface DeviceTokenSet {
  accessToken: string | null;
  tokenType: string | null;
  expiresIn: number | null;
  scope: string | null;
  hasRefreshToken: boolean;
  hasIdToken: boolean;
}

export interface DevicePollOutcome {
  state: DevicePollState;
  message: string;
  tokens?: DeviceTokenSet;
  /** Seconds the client must wait before the next poll, when the server said so. */
  retryAfterSeconds?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Reads the device authorization response; `null` when a required field is missing. */
export function parseDeviceAuthorization(value: unknown): DeviceAuthorization | null {
  const body = asRecord(value);
  if (!body) return null;
  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  const verificationUri = str(body.verification_uri);
  const expiresIn = num(body.expires_in);
  const interval = num(body.interval);
  if (!deviceCode || !userCode || !verificationUri || expiresIn === null || interval === null) return null;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: str(body.verification_uri_complete) ?? verificationUri,
    expiresIn,
    interval,
  };
}

function parseTokenSet(value: unknown): DeviceTokenSet | null {
  const body = asRecord(value);
  if (!body) return null;
  const accessToken = str(body.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    tokenType: str(body.token_type),
    expiresIn: num(body.expires_in),
    scope: str(body.scope),
    hasRefreshToken: Boolean(str(body.refresh_token)),
    hasIdToken: Boolean(str(body.id_token)),
  };
}

const ERROR_STATES: Record<string, { state: DevicePollState; message: string }> = {
  authorization_pending: { state: "pending", message: "Waiting for the code to be approved at the verification page." },
  slow_down: { state: "slow-down", message: "Polled too fast. The interval is raised by five seconds for this code." },
  access_denied: { state: "denied", message: "The request was denied at the verification page." },
  expired_token: { state: "expired", message: "The code expired or was already used. Start a new request." },
  invalid_grant: { state: "failed", message: "The code is not valid for this application any more." },
  invalid_client: { state: "failed", message: "The application credentials were rejected." },
  unsupported_grant_type: { state: "failed", message: "The device grant is off on this instance." },
};

/**
 * Reads one answer from `POST /oauth/token`. The endpoint answers 200 with a token set or 400 with
 * `{ error }`, so the status alone never decides the outcome.
 */
export function readPollOutcome(status: number, body: unknown): DevicePollOutcome {
  const record = asRecord(body);
  if (status >= 200 && status < 300) {
    const tokens = parseTokenSet(body);
    if (tokens) {
      const scope = tokens.scope ? ` Scope ${tokens.scope}.` : "";
      const lifetime = tokens.expiresIn !== null ? ` Expires in ${tokens.expiresIn} seconds.` : "";
      return {
        state: "complete",
        message: `Approved. The token set arrived.${scope}${lifetime}`,
        tokens,
      };
    }
    return { state: "failed", message: "The instance answered 200 without an access token." };
  }
  const code = str(record?.error);
  const description = str(record?.error_description);
  const known = code ? ERROR_STATES[code] : undefined;
  const retryAfter = num(record?.retry_after);
  if (known) {
    return {
      state: known.state,
      message: description ? `${known.message} ${description}` : known.message,
      ...(retryAfter !== null ? { retryAfterSeconds: retryAfter } : {}),
    };
  }
  return {
    state: "failed",
    message: description ?? (code ? `The token endpoint answered ${code}.` : `The token endpoint answered ${status}.`),
  };
}

/** Public applications first: the device grant does not need a client secret, so those are the easy pick. */
export function orderApplicationsForDeviceFlow<T extends { public: boolean; name: string }>(applications: T[]): T[] {
  return [...applications].sort((left, right) => {
    if (left.public !== right.public) return left.public ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** User codes are shown as `ABCD-EFGH`; accept lower case and missing dashes when typed back. */
export function normalizeUserCode(input: string): string {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

interface DeviceFlowState {
  flow: DeviceFlowRecord | null;
}

function state(): DeviceFlowState {
  const scope = globalThis as unknown as Record<string, DeviceFlowState | undefined>;
  scope.__orbitidPlaygroundDeviceFlow ??= { flow: null };
  return scope.__orbitidPlaygroundDeviceFlow;
}

/** One flow at a time is enough for a test page, and keeps the code in the dev server. */
export function rememberDeviceFlow(flow: DeviceFlowRecord): DeviceFlowRecord {
  state().flow = flow;
  return flow;
}

export function getDeviceFlow(): DeviceFlowRecord | null {
  return state().flow;
}

export function clearDeviceFlow(): void {
  state().flow = null;
}

export function recordDevicePoll(poll: DevicePoll): DeviceFlowRecord | null {
  const flow = state().flow;
  if (!flow) return null;
  flow.polls = [...flow.polls, poll].slice(-20);
  return flow;
}

/**
 * What the page may render. The device code is deliberately absent: it stays in the dev server, because
 * anyone holding it can claim the token set.
 */
export type DeviceFlowView = Omit<DeviceFlowRecord, "deviceCode">;

export function deviceFlowView(flow: DeviceFlowRecord | null): DeviceFlowView | null {
  if (!flow) return null;
  const { deviceCode: _deviceCode, ...view } = flow;
  return view;
}
