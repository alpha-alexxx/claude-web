import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Security-critical tests must not hang: hard 15s per test.
    testTimeout: 15000,
  },
});
