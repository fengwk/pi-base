import { resolve } from "node:path";
import { loadPiBaseSettings, type LoadedPiBaseSettings } from "./config.js";

const runtimeSettingsByScope = new Map<string, LoadedPiBaseSettings>();

function scopeKey(cwd: string): string {
  return resolve(cwd);
}

export function loadRuntimePiBaseSettings(cwd: string): LoadedPiBaseSettings {
  const key = scopeKey(cwd);
  const cached = runtimeSettingsByScope.get(key);
  if (cached) return cached;
  const loaded = loadPiBaseSettings(cwd);
  runtimeSettingsByScope.set(key, loaded);
  return loaded;
}

export function reloadRuntimePiBaseSettings(cwd?: string): void {
  if (cwd === undefined) {
    runtimeSettingsByScope.clear();
    return;
  }
  runtimeSettingsByScope.delete(scopeKey(cwd));
}

export function toggleRuntimeYolo(cwd: string): boolean {
  const loaded = loadRuntimePiBaseSettings(cwd);
  const enabled = loaded.settings.yolo !== true;
  loaded.settings.yolo = enabled;
  return enabled;
}

export function isRuntimeYoloEnabled(cwd: string): boolean {
  return loadRuntimePiBaseSettings(cwd).settings.yolo === true;
}
