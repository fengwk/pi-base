import { describe, expect, it } from "vitest";
import { mapFilePathToPath } from "../src/tool-arg-aliases.js";

describe("mapFilePathToPath", () => {
  it("rewrites filePath to path when path is absent", () => {
    const result = mapFilePathToPath({ filePath: "/tmp/foo.txt", offset: "10", limit: "20" });
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

  it("returns args unchanged when neither filePath nor path is present", () => {
    const args = { pattern: "TODO", path: "/tmp/foo.txt" };
    const result = mapFilePathToPath(args);
    expect(result).toBe(args);
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
