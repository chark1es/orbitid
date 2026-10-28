import { describe, expect, it } from "vitest";
import { usersListPath, buildListPath, limitFromParam, pageFromParam } from "./query";

describe("usersListPath", () => {
  it("maps page/limit to a zero-based offset with sorting and search", () => {
    expect(usersListPath({ page: 1, limit: 20, orderBy: "-created_at" })).toBe(
      "/users?limit=20&offset=0&order_by=-created_at&paginated=true",
    );
    expect(usersListPath({ page: 3, limit: 20, query: "ann@example.com", orderBy: "created_at" })).toBe(
      "/users?limit=20&offset=40&order_by=created_at&query=ann%40example.com&paginated=true",
    );
  });

  it("serialises only active filters", () => {
    const path = usersListPath({
      page: 2,
      limit: 10,
      banned: true,
      locked: false,
      mfa: true,
      createdAfter: 1_700_000_000_000,
      createdBefore: undefined,
    });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("offset")).toBe("10");
    expect(params.get("banned")).toBe("true");
    expect(params.get("locked")).toBeNull();
    expect(params.get("mfa")).toBe("true");
    expect(params.get("created_at_after")).toBe("1700000000000");
    expect(params.get("created_at_before")).toBeNull();
  });
});

describe("buildListPath", () => {
  it("appends extra parameters and drops empty values", () => {
    expect(
      buildListPath("/sessions", {
        limit: 25,
        page: 4,
        orderBy: "-created_at",
        extra: { status: "active", user_id: undefined, legacy: false },
      }),
    ).toBe("/sessions?limit=25&offset=75&order_by=-created_at&status=active");
  });
});

describe("query parameter parsing", () => {
  it("clamps invalid page and limit values", () => {
    expect(pageFromParam("0")).toBe(1);
    expect(pageFromParam("-3")).toBe(1);
    expect(pageFromParam("7")).toBe(7);
    expect(pageFromParam(null)).toBe(1);
    expect(limitFromParam("500")).toBe(20);
    expect(limitFromParam("50")).toBe(50);
    expect(limitFromParam(null, 10)).toBe(10);
  });
});
