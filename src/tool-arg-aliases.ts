/**
 * Silent argument-name aliasing for tools.
 *
 * Some upstream models occasionally pass `file`, `filePath`, or `file_path`
 * instead of `path` for path-bearing tools. Rather than surfacing a validation error
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

const FILE_PATH_ALIASES = ["file", "filePath", "file_path"] as const;

/**
 * If `args` contains exactly one known file alias but not `path`, returns a copy
 * where the alias is removed and its value is assigned to `path`. Otherwise
 * returns `args` unchanged. Other keys are preserved verbatim.
 *
 * Designed for tools whose schema declares `path` as a required string.
 */
export function mapFilePathToPath<T = unknown>(args: T): T {
  if (!isRecord(args)) return args;
  if ("path" in args) return args;
  const aliases = FILE_PATH_ALIASES.filter((alias) => alias in args);
  if (aliases.length !== 1) return args;
  const alias = aliases[0]!;
  const result: Record<string, unknown> = { ...args, path: args[alias] };
  delete result[alias];
  return result as T;
}
