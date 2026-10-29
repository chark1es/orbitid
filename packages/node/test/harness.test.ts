import { describe, expect, it } from "vitest";
import { startRealServer, createUserWithSession, createOrganization, tokenWithOrganization } from "./helpers/server";

describe("test harness", () => {
  it("boots the real server and signs in", async () => {
    const server = await startRealServer();
    try {
      const user = await createUserWithSession(server);
      expect(user.token.split(".")).toHaveLength(3);
      const orgId = await createOrganization(server, user.userId);
      const orgToken = await tokenWithOrganization(server, user, orgId);
      expect(orgToken).not.toBe(user.token);
    } finally {
      await server.close();
    }
  });
});
