import { describe, expect, it } from "vitest";
import { mapFilePathToPath } from "../src/tool-arg-aliases.js";

describe("mapFilePathToPath", () => {
  it.each(["file", "filePath", "file_path"])("rewrites %s to path when path is absent", (alias) => {
    // Intent: tolerate only the observed path-key spellings without weakening the canonical schema.
    const result = mapFilePathToPath({ [alias]: "/tmp/foo.txt", offset: "10", limit: "20" });
    expect(result).toEqual({ path: "/tmp/foo.txt", offset: "10", limit: "20" });
  });

  it("returns args unchanged when both filePath and path are present", () => {
    const args = { filePath: "/tmp/wrong.txt", path: "/tmp/right.txt" };
    const result = mapFilePathToPath(args);
    expect(result).toBe(args);
  });

  it("returns args unchanged when only path is present", () => {
    const args = { path: "/tmp/foo.txt", offset: "10" };
    const result = mapFilePathToPath(args);
    expect(result).toBe(args);
  });

  it("returns args unchanged when no path key or alias is present", () => {
    const args = { pattern: "TODO" };
    const result = mapFilePathToPath(args);
    expect(result).toBe(args);
  });

  it("returns args unchanged when multiple aliases are present", () => {
    // Intent: conflicting compatibility aliases must not silently choose a target path.
    const args = { file: "/tmp/one.txt", filePath: "/tmp/two.txt" };
    expect(mapFilePathToPath(args)).toBe(args);
  });

  it("returns args unchanged for non-object inputs", () => {
    expect(mapFilePathToPath(null)).toBe(null);
    expect(mapFilePathToPath(undefined)).toBe(undefined);
    expect(mapFilePathToPath("not-an-object")).toBe("not-an-object");
    expect(mapFilePathToPath(42)).toBe(42);
    expect(mapFilePathToPath([])).toEqual([]);
  });

  it("preserves all other keys verbatim", () => {
    const args = {
      filePath: "/tmp/foo.txt",
      offset: "1",
      limit: "100",
      workdir: "/home",
      replace_all: true,
    };
    const result = mapFilePathToPath(args);
    expect(result).toEqual({
      path: "/tmp/foo.txt",
      offset: "1",
      limit: "100",
      workdir: "/home",
      replace_all: true,
    });
    expect(result).not.toHaveProperty("filePath");
  });

  it("treats filePath: null as still-mapping (schema rejects later)", () => {
    const result = mapFilePathToPath({ filePath: null });
    expect(result).toEqual({ path: null });
  });
});
