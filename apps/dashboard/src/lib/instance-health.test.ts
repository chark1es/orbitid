import { describe, expect, it, vi } from "vitest";
import { databaseSupportNote, databaseLabel, fetchInstanceHealth } from "./instance-health";

function health(body: unknown): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

describe("instance health", () => {
  it("reads the Postgres fields the Rust server reports", async () => {
    health({ status: "ok", publishable_key: "pk_test_demo", database: "postgres", database_driver: "postgres" });
    const result = await fetchInstanceHealth("http://localhost:4000/");
    expect(result).toEqual({
      apiUrl: "http://localhost:4000",
      status: "ok",
      database: "postgres",
      databaseDriver: "postgres",
      publishableKey: "pk_test_demo",
    });
    expect(databaseSupportNote(result.database, result.databaseDriver)).toBeNull();
  });

  it("stays graceful when an older server reports SQLite", async () => {
    health({ status: "ok", database: "sqlite" });
    const result = await fetchInstanceHealth("http://localhost:4000");
    expect(result.database).toBe("sqlite");
    expect(result.databaseDriver).toBeNull();
    expect(databaseLabel(result.database)).toBe("SQLite");
    expect(databaseSupportNote(result.database)).toMatch(/no longer supports/);
  });

  it("does not invent a database the server did not report", async () => {
    health({ status: "ok" });
    const result = await fetchInstanceHealth("http://localhost:4000");
    expect(result.database).toBeNull();
    expect(databaseLabel(result.database)).toBe("Database unknown");
    expect(databaseSupportNote(result.database)).toBeNull();
  });

  it("names an unexpected driver without pretending it is Postgres", () => {
    expect(databaseSupportNote("postgres", "pglite")).toMatch(/"pglite" driver/);
  });
});
