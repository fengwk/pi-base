import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/schemas/subagent.ts",
        "src/subagent/prompt.ts",
        "src/subagent/runner.ts",
        "src/subagent/transcript.ts"
      ],
      exclude: [
        "tests/**"
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95
      }
    }
  }
});
