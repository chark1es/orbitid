import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { ORBITID_DASHBOARD_DIR: "/nonexistent-dashboard" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
