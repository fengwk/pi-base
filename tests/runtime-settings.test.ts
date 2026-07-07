import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRuntimeYoloEnabled,
  loadRuntimePiBaseSettings,
  reloadRuntimePiBaseSettings,
  toggleRuntimeYolo,
} from "../src/runtime-settings.js";
import { createTempWorkspace } from "./helpers.js";

async function withIsolatedGlobalSettings<T>(run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
  const root = await createTempWorkspace();
  process.env.PI_BASE_GLOBAL_SETTINGS_PATH = join(root, "global-pi-base.json");
  await writeFile(process.env.PI_BASE_GLOBAL_SETTINGS_PATH, JSON.stringify({}), "utf8");
  try {
    return await run();
  } finally {
    reloadRuntimePiBaseSettings();
    if (previous === undefined) {
      delete process.env.PI_BASE_GLOBAL_SETTINGS_PATH;
    } else {
      process.env.PI_BASE_GLOBAL_SETTINGS_PATH = previous;
    }
  }
}

async function writeProjectSettings(root: string, settings: unknown): Promise<void> {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "pi-base.json"), JSON.stringify(settings), "utf8");
}

describe("runtime settings", () => {
  it("keeps /yolo runtime-only until a scoped reload rereads project settings", async () => {
    // Intent: /yolo mutates the in-memory runtime snapshot; /reload for the
    // project must discard that override and return to file-backed settings.
    await withIsolatedGlobalSettings(async () => {
      const root = await createTempWorkspace();
      await writeProjectSettings(root, { yolo: false });

      expect(isRuntimeYoloEnabled(root)).toBe(false);
      expect(toggleRuntimeYolo(root)).toBe(true);
      expect(isRuntimeYoloEnabled(root)).toBe(true);
      expect(loadRuntimePiBaseSettings(root).settings.yolo).toBe(true);

      reloadRuntimePiBaseSettings(root);

      expect(isRuntimeYoloEnabled(root)).toBe(false);
    });
  });

  it("clears every cached scope on global reload", async () => {
    // Intent: extension reload calls the global form, so all project snapshots
    // must be refreshed rather than only the current cwd.
    await withIsolatedGlobalSettings(async () => {
      const first = await createTempWorkspace();
      const second = await createTempWorkspace();
      await writeProjectSettings(first, { yolo: false });
      await writeProjectSettings(second, { yolo: false });

      expect(toggleRuntimeYolo(first)).toBe(true);
      expect(toggleRuntimeYolo(second)).toBe(true);

      reloadRuntimePiBaseSettings();

      expect(isRuntimeYoloEnabled(first)).toBe(false);
      expect(isRuntimeYoloEnabled(second)).toBe(false);
    });
  });
});
