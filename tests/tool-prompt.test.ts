import { describe, expect, it } from "vitest";
import { loadToolDescription } from "../src/tool-prompt.js";

describe("tool prompt loading", () => {
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
