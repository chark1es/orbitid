import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/support/global-postgres.ts"],
    setupFiles: ["./test/support/ephemeral-db.ts"],
    env: { ORBITID_DATABASE_POOL: "2" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
