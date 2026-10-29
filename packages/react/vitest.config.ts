import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/__tests__/setup.ts"],
    environmentOptions: { jsdom: { url: "http://localhost:3000/" } },
    restoreMocks: true,
    clearMocks: true,
    // The workspace suites run side by side; give slow UI interactions room so load does not cause false failures.
    testTimeout: 20_000,
  },
});
