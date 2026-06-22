import { Type } from "@sinclair/typebox";

/**
 * `find` schema for pi-base.
 *
 * Upstream `pi-coding-agent` declares `path` as optional, with an implicit
 * default of `"."` resolved against `ctx.cwd`. That default is a hidden
 * search-scope decision the model never made explicitly, and it is a
 * frequent source of agent hallucinations: a call like
 * `find({ pattern: "*.ts" })` quietly searches the session cwd, not the
 * directory the model is "thinking about".
 *
 * pi-base overrides this: `path` is required. The model must state the
 * directory it wants to search. Use `"."` if the intent really is the
 * current working directory. There is no implicit fallback.
 */
export const findSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'.",
  }),
  path: Type.String({
    description: "Directory to search in. Required. Use '.' for the current working directory. There is no implicit default — the model must always state the search root.",
  }),
  workdir: Type.Optional(Type.String({
    description: "Working directory for resolving relative paths. Defaults to the current working directory. If provided, relative paths resolve from that directory.",
  })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results. Default: 1000." })),
  timeout_seconds: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Optional timeout in seconds. No default timeout." })),
});
