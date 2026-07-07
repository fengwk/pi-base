import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      exclude: [
        "tests/**",
        // Vendored upstream utilities are covered through grep/find/bash
        // integration behavior; pi-base's effective unit coverage tracks its
        // own implementation surface.
        "src/internal/**"
      ],
      thresholds: {
        statements: 90,
        functions: 90,
        lines: 90
      }
    }
  }
});
