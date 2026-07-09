/**
 * Silent argument-name aliasing for tools.
 *
 * Some upstream models (e.g. DeepSeek V4) occasionally pass `filePath` instead
 * of `path` for path-bearing tools. Rather than surfacing a validation error
 * (which the model often misreads and keeps repeating), `prepareArguments`
 * hooks can call these helpers to silently rewrite the argument keys before
 * the TypeBox schema validation runs.
 *
 * These aliases are intentionally not advertised in the tool's `description`
 * or `promptSnippet` — they only kick in when the model gets the name wrong.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * If `args` contains `filePath` but not `path`, returns a copy where
 * `filePath` is removed and its value is assigned to `path`. Otherwise
 * returns `args` unchanged. Other keys are preserved verbatim.
 *
 * Designed for tools whose schema declares `path` as a required string.
 */
export function mapFilePathToPath<T = unknown>(args: T): T {
  if (!isRecord(args)) return args;
  if (!("filePath" in args) || "path" in args) return args;
  const { filePath, ...rest } = args;
  return { ...rest, path: filePath } as T;
}
