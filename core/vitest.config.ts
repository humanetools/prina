import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Test files share a single embedded Postgres — isolated per workspace
    fileParallelism: false,
  },
});
