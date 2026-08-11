<p align="center">
  🌐 <a href="development.md">English</a> · <a href="development.zh-CN.md">简体中文</a>
</p>

# Developer Guide

## Environment requirements

- Node.js `>=22.19.0`
- npm
- Pi-related peer dependencies are provided by the repository's dev dependencies

Install dependencies:

```bash
npm install
```

Verification commands:

```bash
npm run typecheck
npm test
npm run test:coverage
```

## Repository layout

```text
index.ts                 Pi package entry point
src/                     TypeScript implementation
  schemas/               TypeBox tool schemas
  lsp/                   LSP discovery/client/tools
  mcp/                   MCP transport/hub/tools
  subagent/              task and child sessions
  goal/                  Goal state and control tools
  internal/              necessary vendored helpers
prompts/                 tool instructions injected into the model
skills/                  skills shipped with the package
scripts/                 notification scripts
examples/                configuration and agent examples
tests/                   Vitest tests
docs/                    development and implementation docs
```

## Modifying an existing tool

When modifying a tool, check the following locations:

1. The public argument contract in `src/schemas/<tool>.ts`.
2. The model instructions in `prompts/<tool>.md`.
3. The `prepareArguments`, renderer, and execute wiring in the registration module.
4. Abort, timeout, path, and error semantics in the core execution file.
5. Permission, LSP sync, unified truncation, and context compression integration.
6. The corresponding tests and renderer tests.
7. `docs/tools/<tool>.md`.

Do not change only the execution function while missing the schema, prompt, or tests.

## Adding a static tool

Reference layout for a static tool:

```text
src/schemas/example.ts
src/example-core.ts
src/example-register.ts
prompts/example.md
tests/example.test.ts
docs/tools/example.md
```

Minimal implementation steps:

1. Define a strict TypeBox schema.
2. Load the description and prompt snippet at the register layer.
3. Handle necessary compatibility mappings in `prepareArguments`.
4. Separate call rendering, execution, and result rendering.
5. Wrap error results with `withPiBaseErrorMarker`.
6. Register the tool in `src/index-impl.ts`.
7. Add the tool to the correct agent tool projection.
8. Add tests for success, failure, abort, timeout, and edge cases.

## Schema and execution validation

The schema is the model-side contract, but execute must still validate direct-call scenarios. Tests may call `execute` directly, bypassing Pi's schema validation, so core execution functions cannot assume arguments are already reliable.

Validation at the execution layer:

- Required strings reject missing and blank values.
- Numbers use a unified parser and are range-checked.
- Relative paths go through `resolveToolWorkdir` and `resolveToCwd`.
- Abort is checked before expensive I/O.
- Timeout uses [`src/timeout.ts`](../src/timeout.ts).

## Error results

Expected errors from tool execution should return:

```ts
{
  content: [{ type: "text", text: "Error: ..." }],
  isError: true
}
```

Registration objects should use `withPiBaseErrorMarker` so the global `tool_result` hook can reliably recover `isError`.

Do not use exceptions for ordinary user errors; exceptions are for unexpected failures that cannot be reasonably converted at the core layer.

## Renderer

Call and result renderers should consider separately:

- Arguments are still being streamed.
- Arguments are complete.
- The tool is executing.
- The result succeeded or failed.
- Collapsed and expanded states.
- Fast execution under YOLO.
- Terminal display width.

Public helpers live in [`src/render.ts`](../src/render.ts). File-modifying tools must also ensure the call preview does not change what is actually written.

## Files and encoding

Text tools share the following constraints:

- Only regular files are processed.
- Binary files must be explicitly rejected.
- [`src/text-codec.ts`](../src/text-codec.ts) detects BOM, UTF-16, and legacy encodings.
- `edit` / `apply_patch` preserve line endings via [`src/line-endings.ts`](../src/line-endings.ts).
- Writing back legacy encodings must be lossless; fail rather than substituting characters when a value cannot be represented.
- Read-modify-write cycles for the same path should go through the file change queue.

## Child processes

`bash`, `find`, `grep`, and LSP all spawn child processes.

New child-process logic must handle:

- Spawn failure.
- stdout/stderr.
- Non-zero exit codes.
- AbortSignal.
- Timeout.
- Process tree termination.
- Listener and timer cleanup.

Generic termination logic lives in [`src/process-termination.ts`](../src/process-termination.ts).

## Tests

Vitest only collects `tests/**/*.test.ts`; the default per-test timeout is 10 seconds.

Coverage thresholds:

- statements: 90%
- functions: 90%
- lines: 90%

`src/internal/**` does not count toward direct coverage; it is verified through higher-level integration behavior.

Test conventions:

- Use [`tests/helpers.ts`](../tests/helpers.ts) to create temporary workspaces and a mock Pi registry.
- Write the test intent as a short comment.
- Test temp files go in the system temp directory.
- Do not depend on the developer's HOME, fixed checkout paths, or global configuration.
- Explicitly mock platform branches or use platform conditions.

## Documentation sync

The following changes must be reflected in the docs:

| Change | Documentation |
|--------|---------------|
| Tool arguments or defaults | The corresponding `docs/tools/*.md` |
| Configuration fields or merge rules | `docs/configuration.md` |
| Lifecycle or module relationships | `docs/architecture.md` |
| User installation and first-use flow | The root `README.md` |
| Third-party sources | `THIRD_PARTY_NOTICES` and `LICENSES` |

## Pre-release checklist

```bash
npm run typecheck
npm run test:coverage
npm audit
npm pack --dry-run
git diff --check
```

Also check:

- No temporary files in the workspace.
- Local links in the README and docs are valid.
- JSON examples parse.
- Third-party code sources and licenses are recorded in `LICENSES` and `THIRD_PARTY_NOTICES`.
- Git notes refs are empty; tracked files contain no secrets, tokens, or private internal addresses.
