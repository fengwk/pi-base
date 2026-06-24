import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Filesystem, NotFoundError, type WriteResult } from "./hashline/index.js";
import { canonicalSnapshotKey } from "./hashline-session.js";
import { resolveToCwd, stripAtPrefix } from "./path-utils.js";

export interface PiBaseHashlineFilesystemOptions {
  cwd: string;
  signal?: AbortSignal;
  onWrite?: (absolutePath: string, writtenText: string) => Promise<void> | void;
}

/** Node-backed filesystem adapter that resolves hashline section paths against tool cwd. */
export class PiBaseHashlineFilesystem extends Filesystem {
  readonly #cwd: string;
  readonly #signal: AbortSignal | undefined;
  readonly #onWrite: ((absolutePath: string, writtenText: string) => Promise<void> | void) | undefined;

  constructor(options: PiBaseHashlineFilesystemOptions) {
    super();
    this.#cwd = options.cwd;
    this.#signal = options.signal;
    this.#onWrite = options.onWrite;
  }

  resolveAbsolute(relativePath: string): string {
    return resolveToCwd(stripAtPrefix(relativePath), this.#cwd);
  }

  canonicalPath(relativePath: string): string {
    return canonicalSnapshotKey(this.resolveAbsolute(relativePath));
  }

  async readText(relativePath: string): Promise<string> {
    const absolutePath = this.resolveAbsolute(relativePath);
    try {
      this.#signal?.throwIfAborted?.();
      return await readFile(absolutePath, "utf8");
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") {
        throw new NotFoundError(relativePath, error);
      }
      throw error;
    }
  }

  async preflightWrite(relativePath: string): Promise<void> {
    const absolutePath = this.resolveAbsolute(relativePath);
    this.#signal?.throwIfAborted?.();
    await mkdir(dirname(absolutePath), { recursive: true });
  }

  async writeText(relativePath: string, content: string): Promise<WriteResult> {
    const absolutePath = this.resolveAbsolute(relativePath);
    this.#signal?.throwIfAborted?.();
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    await this.#onWrite?.(absolutePath, content);
    return { text: content };
  }

  async exists(relativePath: string): Promise<boolean> {
    const absolutePath = this.resolveAbsolute(relativePath);
    try {
      await stat(absolutePath);
      return true;
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") return false;
      throw error;
    }
  }
}
