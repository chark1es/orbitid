// P1: consuming a refresh token, checking the family is still live and inserting its successor/access token must
// be one serialized unit. The old code consumed the row, then inserted the successor later; a second request that
// observed the gap declared theft and revoked the family, after which the first request inserted live tokens into
// that revoked family. This test pauses the winner in exactly that gap and runs the loser on a second connection.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createContext } from "../../src/bootstrap";
import { dialect } from "../../src/db";
import * as s from "../../src/db/schema";
import { createApplication } from "../../src/services/oidc/applications";
import { exchangeAuthorizationCode, exchangeRefreshToken, issueAuthorizationCode } from "../../src/services/oidc/tokens";
import { insertClientSession, insertUser } from "../machine/helpers";
import { createDedicatedPostgresDatabase } from "../support/ephemeral-db";

const ENCRYPTION_KEY = "rotation-atomic-key".padEnd(32, "x");
const REDIRECT_URI = "http://localhost:3000/callback";

interface Target {
  databaseUrl: string;
  dataDir: string;
  cleanup(): Promise<void>;
}

async function sharedTarget(): Promise<Target> {
  if (dialect === "postgres") {
    const database = await createDedicatedPostgresDatabase();
    return {
      databaseUrl: database.url,
      dataDir: mkdtempSync(join(tmpdir(), "orbitid-rotation-pg-")),
      cleanup: async () => {
        rmSync(join(tmpdir(), "orbitid-rotation-pg-"), { recursive: true, force: true });
        await database.drop();
      },
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "orbitid-rotation-sqlite-"));
  return {
    databaseUrl: `sqlite:${join(dir, "orbitid.db")}`,
    dataDir: dir,
    cleanup: async () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function open(target: Target) {
  return createContext({
    databaseUrl: target.databaseUrl,
    dataDir: target.dataDir,
    secretKey: "sk_test_rotation_atomic",
    baseUrl: "http://localhost:4000",
    nodeEnv: "test",
    encryptionKey: ENCRYPTION_KEY,
  });
}

describe("OIDC refresh rotation atomicity", () => {
  let target: Target;
  let a: Awaited<ReturnType<typeof open>>;
  let b: Awaited<ReturnType<typeof open>>;

  beforeEach(async () => {
    target = await sharedTarget();
    a = await open(target);
    b = await open(target);
  });

  afterEach(async () => {
    await a?.close();
    await b?.close();
    await target?.cleanup();
  });

  it("serializes consume+insert: a concurrent duplicate blocks, then returns the winner's successor", async () => {
    const user = await insertUser(a, { email: "rotation@example.com" });
    const session = await insertClientSession(a, user.userId);
    const { row: application } = await createApplication(a, {
      name: "Rotation",
      redirectUris: [REDIRECT_URI],
      scopes: "openid profile offline_access",
    });
    const scopes = ["openid", "offline_access"];
    const code = await issueAuthorizationCode(a, {
      application, userId: user.userId, scopes, redirectUri: REDIRECT_URI, sessionId: session.sessionId,
    });
    const first = await exchangeAuthorizationCode(a, { application, code, redirectUri: REDIRECT_URI });
    const original = first.refresh_token!;
    expect(original).toBeTruthy();

    // Pause A inside its rotation transaction, after the conditional consumption and before either insert.
    let reachedGap!: () => void;
    const atGap = new Promise<void>((resolve) => { reachedGap = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const winner = exchangeRefreshToken(a, application, original, {
      hooks: { afterConsume: async () => { reachedGap(); await released; } },
    });
    await atGap;

    // The duplicate runs on a second connection while the winner is paused.
    const loser = exchangeRefreshToken(b, application, original);
    const state = await Promise.race([
      loser.then(() => "finished" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 200)),
    ]);
    expect(state).toBe("blocked");

    release();
    const [winnerTokens, loserTokens] = await Promise.all([winner, loser]);

    // The loser must reuse the winner's successor and must not have revoked anything.
    expect(loserTokens.refresh_token).toBe(winnerTokens.refresh_token);
    const grants = await a.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.applicationId, application.id));
    const refreshes = grants.filter((row) => row.kind === "refresh");
    expect(refreshes).toHaveLength(2);
    const consumed = refreshes.find((row) => row.tokenHash !== winnerTokens.refresh_token)!;
    const successor = refreshes.find((row) => row !== consumed)!;
    expect(consumed.revoked).toBe(true);
    expect(consumed.consumedAt).toBeTruthy();
    expect(consumed.successorId).toBe(successor.id);
    // Family revocation would mark every row (including the access tokens) revoked. Only the consumed predecessor is.
    expect(successor.revoked).toBe(false);
    expect(grants.filter((row) => row.kind === "access").every((row) => !row.revoked)).toBe(true);
    expect(grants.filter((row) => row.kind !== "code" && row.revoked)).toHaveLength(1);
  });

  it("refuses to insert a successor into a family revoked while the rotation was prepared", async () => {
    const user = await insertUser(a, { email: "revoked-family@example.com" });
    const session = await insertClientSession(a, user.userId);
    const { row: application } = await createApplication(a, {
      name: "Revoked family",
      redirectUris: [REDIRECT_URI],
      scopes: "openid offline_access",
    });
    const code = await issueAuthorizationCode(a, {
      application, userId: user.userId, scopes: ["openid", "offline_access"], redirectUri: REDIRECT_URI, sessionId: session.sessionId,
    });
    const { refresh_token: original } = await exchangeAuthorizationCode(a, { application, code, redirectUri: REDIRECT_URI });

    // End the authorizing session, which revokes every grant in the family, after this rotation prepared its token
    // set but before it can consume the predecessor or insert anything.
    const { revokeGrantsForSession } = await import("../../src/services/oidc/revocation");
    const rotation = exchangeRefreshToken(a, application, original!, {
      hooks: {
        beforeConsume: async () => {
          await revokeGrantsForSession(b, session.sessionId);
        },
      },
    });

    await expect(rotation).rejects.toMatchObject({ error: "invalid_grant" });
    const grants = await a.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.applicationId, application.id));
    expect(grants.every((row) => row.revoked)).toBe(true);
    // No live successor was created into the dead family.
    expect(grants.filter((row) => row.kind === "refresh" && !row.revoked)).toHaveLength(0);
    expect(grants.filter((row) => row.kind === "access" && !row.revoked)).toHaveLength(0);
    expect(grants.filter((row) => row.kind === "refresh")).toHaveLength(1);
  });
});
