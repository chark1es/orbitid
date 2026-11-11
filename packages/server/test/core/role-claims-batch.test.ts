// Token minting must not run one permissions query per assigned role: that is O(roles) round trips on every token
// refresh. The union is now resolved with a single IN query. The proxy-count assertion is the regression: adding
// roles must not add queries.
import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context";
import * as s from "../../src/db/schema";
import { roleClaimsForUser } from "../../src/services/user-roles";
import { grantPermissions, insertUser, setup } from "../machine/helpers";

describe("instance role claims", () => {
  it("loads every role's permissions in one query, whatever the number of roles", async () => {
    const { ctx } = await setup();
    const user = await insertUser(ctx, { email: "roles@example.com" });
    const roleKeys = ["app:analyst", "app:auditor", "app:support"];
    for (const [index, key] of roleKeys.entries()) {
      const role = await grantPermissions(ctx, key, [`app:batch:${index}`]);
      await ctx.db.insert(s.userRoles).values({
        userId: user.userId, roleKey: key, createdAt: Date.now(), updatedAt: Date.now(),
      });
      expect(role.id).toBeTruthy();
    }

    let selects = 0;
    const target = ctx.db;
    const counted = new Proxy(target, {
      get(object, property, receiver) {
        if (property === "select") selects += 1;
        const value = Reflect.get(object, property, receiver);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
    const counting: AppContext = { ...ctx, db: counted };

    const claims = await roleClaimsForUser(counting, user.userId);
    expect(claims.roles).toEqual(["app:analyst", "app:auditor", "app:support"]);
    expect(claims.permissions).toEqual(["app:batch:0", "app:batch:1", "app:batch:2"]);
    // user_roles + roles + one role_permissions IN query. The old code needed one extra query per role (6 here).
    expect(selects).toBe(3);
  });

  it("drops a non-instance role without querying its permissions", async () => {
    const { ctx } = await setup();
    const user = await insertUser(ctx, { email: "roles-missing@example.com" });
    await grantPermissions(ctx, "app:kept", ["app:kept:read"]);
    await ctx.db.insert(s.userRoles).values([
      { userId: user.userId, roleKey: "app:kept", createdAt: Date.now(), updatedAt: Date.now() },
      { userId: user.userId, roleKey: "org:admin", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    const claims = await roleClaimsForUser(ctx, user.userId);
    expect(claims.roles).toEqual(["app:kept"]);
    expect(claims.permissions).toEqual(["app:kept:read"]);
  });
});
