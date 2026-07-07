import { describe, expect, it } from "vitest";
import {
  buildImageReadDowngradeMessage,
  IMAGE_UNDERSTANDING_SKILL_DIR,
  modelSupportsImages,
} from "../src/image-fallback.js";
import { registerReadTool } from "../src/read.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

describe("modelSupportsImages", () => {
  it("returns true when input includes image", () => {
    expect(modelSupportsImages({ input: ["text", "image"] })).toBe(true);
  });

  it("returns false when input is text-only", () => {
    expect(modelSupportsImages({ input: ["text"] })).toBe(false);
  });

  it("returns false when input is missing", () => {
    expect(modelSupportsImages({})).toBe(false);
  });

  it("returns false when model is undefined (unknown capability)", () => {
    expect(modelSupportsImages(undefined)).toBe(false);
  });
});

describe("read image downgrade", () => {
  it("returns text-only guidance with skill paths and read hint, no image attachment", async () => {
    const root = await createTempWorkspace();
    await writeWorkspaceFile(root, "shot.png", "fake");
    const registry = createToolRegistry();
    registerReadTool(registry.pi as any, {
      createBuiltInReadTool: () => ({
        execute: async () => ({
          content: [
            { type: "text", text: "should not run" },
            { type: "image", data: "YmFzZTY0", mimeType: "image/png" },
          ],
        }),
      }),
    });

    const result = await registry.getTool("read").execute(
      "1",
      { workdir: ".", path: "shot.png" },
      undefined,
      undefined,
      { cwd: root, model: { input: ["text"] } },
    );

    const text = getText(result);
    expect(text).toContain("mediaType: image");
    expect(text).toContain("skillDir:");
    expect(text).toContain(IMAGE_UNDERSTANDING_SKILL_DIR);
    expect(text).toContain("skill: image-understanding");
    expect(text).toContain("skillDoc:");
    expect(text).toContain("read the image-understanding skill");
    expect(text).not.toContain("Parameter Reference");
    expect(text).not.toContain("should not run");
    expect((result.content ?? []).some((item: any) => item.type === "image")).toBe(false);
  });

  it("buildImageReadDowngradeMessage includes absolute path, skill name, and skillDoc", () => {
    const msg = buildImageReadDowngradeMessage("a/b.png", "/tmp/a/b.png");
    expect(msg).toContain("path: a/b.png");
    expect(msg).toContain("absolutePath: /tmp/a/b.png");
    expect(msg).toContain("skillDir:");
    expect(msg).toContain("skill: image-understanding");
    expect(msg).toContain("SKILL.md");
  });
});
