import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // `server-only` exists to make RSC bundlers reject server modules in
    // client graphs; under vitest there is no client graph, so the package's
    // throwing stub is replaced with an empty module. Server modules stay
    // testable while builds keep the real guard.
    alias: {
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Security-critical tests must not hang: hard 15s per test.
    testTimeout: 15000,
  },
});
