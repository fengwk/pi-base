import { describe, expect, it } from "vitest";
import { describeShellFor, loadBashDescription, loadBashPromptSnippet } from "../src/bash-renderer-core.js";
import { loadToolDescription } from "../src/tool-prompt.js";

describe("tool prompt loading", () => {
  it("substitutes every bash placeholder in both the description and the snippet", () => {
    // Intent: loadToolDescription wraps each key as `${key}`, so callers must pass bare names.
    // Passing pre-wrapped `${shell}` keys silently leaves raw placeholders in model-visible text.
    const description = loadBashDescription();
    const shell = describeShellFor({ platform: process.platform, shellPath: process.env.SHELL });
    expect(description).not.toMatch(/\$\{[^}]*\}/);
    expect(description).toContain(`Shell: ${shell}`);
    expect(description).not.toContain("- OS:");
    expect(description).not.toContain("- Note:");
    expect(description).not.toContain("WSL environment.");
    expect(description).not.toContain("Windows files may be accessible under /mnt/<drive>");
    expect(description).not.toContain("Windows commands may be invocable from WSL");
    expect(loadBashPromptSnippet()).not.toMatch(/\$\{[^}]*\}/);
  });

  it("replaces named placeholders in tool descriptions", () => {
    // Intent: prompt snippets use `${name}` placeholders; replacement must use
    // the actual key, not the literal word "placeholder".
    const description = loadToolDescription("bash", {
      shell: "TestShell",
    });

    expect(description).toContain("Shell: TestShell");
    expect(description).not.toContain("${shell}");
  });
});
