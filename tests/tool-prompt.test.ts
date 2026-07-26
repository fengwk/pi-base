import { describe, expect, it } from "vitest";
import { loadBashDescription, loadBashPromptSnippet } from "../src/bash-renderer-core.js";
import { loadToolDescription } from "../src/tool-prompt.js";

describe("tool prompt loading", () => {
  it("substitutes every bash placeholder in both the description and the snippet", () => {
    // Intent: loadToolDescription wraps each key as `${key}`, so callers must pass bare names.
    // Passing pre-wrapped `${os}` keys silently left raw placeholders in the model-visible text.
    const description = loadBashDescription();
    expect(description).not.toMatch(/\$\{[^}]*\}/);
    expect(description).toMatch(/^- OS: \S/m);
    expect(description).toMatch(/^- Shell: \S/m);
    expect(description).toMatch(/^- Note: \S/m);
    expect(loadBashPromptSnippet()).not.toMatch(/\$\{[^}]*\}/);
  });

  it("replaces named placeholders in tool descriptions", () => {
    // Intent: prompt snippets use `${name}` placeholders; replacement must use
    // the actual key, not the literal word "placeholder".
    const description = loadToolDescription("bash", {
      os: "TestOS",
      shell: "TestShell",
      osNote: "TestNote",
    });

    expect(description).toContain("- OS: TestOS");
    expect(description).toContain("- Shell: TestShell");
    expect(description).toContain("- Note: TestNote");
    expect(description).not.toContain("${os}");
  });
});
