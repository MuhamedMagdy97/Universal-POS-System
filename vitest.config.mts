import path from "node:path";
import { defineConfig } from "vitest/config";

const root = path.resolve(import.meta.dirname);

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      // `server-only` throws outside the React server runtime; tests run in plain Node.
      "server-only": path.join(root, "tests/setup/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    globalSetup: ["tests/setup/global-setup.ts"],
    setupFiles: ["tests/setup/env.ts"],
    // Integration tests share one Postgres database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
