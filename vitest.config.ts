import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "index.ts",
        "src/read.ts",
        "src/edit.ts",
        "src/write.ts",
        "src/grep.ts",
        "src/bash-renderer.ts",
        "src/lsp/tools.ts",
        "src/tool-output.ts"
      ],
      exclude: [
        "tests/**",
        "src/hashline.ts",
        "src/edit-diff.ts",
        "src/binary-detect.ts",
        "src/path-utils.ts",
        "src/runtime.ts",
        "src/timeout.ts",
        "src/lsp/client.ts",
        "src/lsp/discovery.ts"
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95
      }
    }
  }
});
