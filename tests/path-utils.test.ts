import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandHomePath, isHomeShortcutPath, normalizeSlashes, resolveToCwd, resolveToolWorkdir, stripAtPrefix } from "../src/path-utils.js";

const home = homedir();

describe("path utilities", () => {
  it("strips agent @ path prefixes without changing ordinary paths", () => {
    expect(stripAtPrefix("@src/index.ts")).toBe("src/index.ts");
    expect(stripAtPrefix("src/index.ts")).toBe("src/index.ts");
  });

  it("normalizes Windows-style separators for matching", () => {
    expect(normalizeSlashes("src\\nested\\file.ts")).toBe("src/nested/file.ts");
  });

  it("expands supported home-directory shortcuts consistently", () => {
    expect(expandHomePath("~")).toBe(home);
    expect(expandHomePath("~/bin/tool")).toBe(join(home, "bin", "tool"));
    expect(expandHomePath("~\\bin\\tool")).toBe(join(home, "bin\\tool"));
    expect(expandHomePath("$HOME/bin/tool")).toBe(join(home, "bin", "tool"));
    expect(expandHomePath("$HOME\\bin\\tool")).toBe(join(home, "bin\\tool"));
    expect(expandHomePath("${HOME}/bin/tool")).toBe(join(home, "bin", "tool"));
    expect(expandHomePath("${HOME}\\bin\\tool")).toBe(join(home, "bin\\tool"));
    expect(expandHomePath("$JAVA_HOME/bin/tool")).toBe("$JAVA_HOME/bin/tool");
  });

  it("identifies only supported home-directory shortcuts", () => {
    expect(isHomeShortcutPath("~")).toBe(true);
    expect(isHomeShortcutPath("~/bin")).toBe(true);
    expect(isHomeShortcutPath("$HOME/bin")).toBe(true);
    expect(isHomeShortcutPath("${HOME}/bin")).toBe(true);
    expect(isHomeShortcutPath("$JAVA_HOME/bin")).toBe(false);
  });

  it("resolves paths against cwd after @ and HOME expansion", () => {
    const cwd = resolve("/tmp", "pi-base-path-utils");
    expect(resolveToCwd("@src/index.ts", cwd)).toBe(resolve(cwd, "src/index.ts"));
    expect(resolveToCwd("${HOME}/src/index.ts", cwd)).toBe(join(home, "src", "index.ts"));

    const relative = resolveToolWorkdir("@packages/app", cwd);
    expect(relative.rawWorkdir).toBe("packages/app");
    expect(relative.cwd).toBe(resolve(cwd, "packages/app"));

    const absolute = resolveToolWorkdir(home, cwd);
    expect(absolute.rawWorkdir).toBe(home);
    expect(isAbsolute(absolute.cwd)).toBe(true);
    expect(absolute.cwd).toBe(home);
  });
});
