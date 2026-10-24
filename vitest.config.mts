import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Storage/audit suites start native children; bound concurrency on shared hosts.
    maxWorkers: 2,
    include: ["**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**", "**/build/**", "**/research/archive/**"],
  },
});
