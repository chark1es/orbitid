import { describe, expect, it } from "vitest";
import type { AuditLogJSON, SessionJSON } from "@orbitid/shared";
import { auditActivityRow, sessionActivityRow, sessionActivityRows } from "./activity";

function session(overrides: Partial<SessionJSON> = {}): SessionJSON {
  return {
    object: "session",
    id: "sess_1",
    status: "active",
    sign_in_method: null,
    expire_at: 1_700_100_000_000,
    abandon_at: 1_700_100_000_000,
    last_active_at: 1_700_000_500_000,
    last_active_organization_id: null,
    actor: null,
    user: null,
    public_user_data: {
      first_name: "Ada",
      last_name: "Lovelace",
      image_url: "",
      has_image: false,
      identifier: "ada@example.com",
      user_id: "user_1",
    },
    factor_verification_age: null,
    last_active_token: null,
    latest_activity: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("sessionActivityRow", () => {
  it("names the person and the identifier separately", () => {
    const row = sessionActivityRow(session());
    expect(row.who).toBe("Ada Lovelace");
    expect(row.whoSub).toBe("ada@example.com");
    expect(row.at).toBe(1_700_000_000_000);
    expect(row.outcome).toBe("success");
    expect(row.detail).toBe("Active");
  });

  it("falls back to the identifier when there is no name", () => {
    const row = sessionActivityRow(
      session({
        public_user_data: {
          first_name: null,
          last_name: null,
          image_url: "",
          has_image: false,
          identifier: "ada@example.com",
          user_id: "user_1",
        },
      }),
    );
    expect(row.who).toBe("ada@example.com");
  });

  it("reports an unknown user without inventing one", () => {
    const row = sessionActivityRow(session({ public_user_data: null }));
    expect(row.who).toBe("Unknown user");
    expect(row.whoSub).toBeUndefined();
  });

  it("reads place, address, browser and device from the latest activity", () => {
    const row = sessionActivityRow(
      session({
        latest_activity: {
          id: "act_1",
          is_mobile: true,
          ip_address: "203.0.113.7",
          city: "Berlin",
          country: "DE",
          browser_name: "Chrome",
          browser_version: "128",
          device_type: "mobile",
        },
      }),
    );
    expect(row.where).toBe("Berlin, DE · 203.0.113.7 · Chrome mobile");
  });

  it("marks a pending session as pending", () => {
    const row = sessionActivityRow(session({ status: "pending" }));
    expect(row.outcome).toBe("pending");
    expect(row.detail).toBe("First factor not finished");
  });

  it("labels an actor-token session as impersonation", () => {
    const row = sessionActivityRow(session({ actor: { sub: "user_admin" } }));
    expect(row.method).toBe("ticket");
    expect(row.detail).toBe("Impersonation");
  });

  it("uses the sign-in method the API recorded, and unknown for older sessions", () => {
    expect(sessionActivityRow({ ...session(), sign_in_method: "passkey" }).method).toBe("passkey");
    expect(sessionActivityRow({ ...session(), sign_in_method: null }).method).toBe("unknown");
  });

  it("maps a list", () => {
    expect(sessionActivityRows([session(), session({ id: "sess_2" })])).toHaveLength(2);
    expect(sessionActivityRows(undefined)).toEqual([]);
  });
});

describe("auditActivityRow", () => {
  const log: AuditLogJSON = {
    object: "audit_log",
    id: "log_1",
    actor: "secret_key",
    action: "user.banned",
    target_type: "user",
    target_id: "user_1",
    metadata: {},
    ip: "203.0.113.7",
    created_at: 1_700_000_000_000,
  };

  it("names the actor, the action and the address", () => {
    const row = auditActivityRow(log);
    expect(row.who).toBe("Secret key");
    expect(row.whoSub).toBe("user_1");
    expect(row.detail).toBe("user.banned");
    expect(row.where).toBe("203.0.113.7");
    expect(row.outcome).toBe("success");
  });

  it("labels anonymous and system actors", () => {
    expect(auditActivityRow({ ...log, actor: "anonymous" }).who).toBe("Anonymous");
    expect(auditActivityRow({ ...log, actor: null }).who).toBe("System");
  });
});
