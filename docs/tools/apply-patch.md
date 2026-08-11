<p align="center">
  🌐 <a href="apply-patch.md">English</a> · <a href="apply-patch.zh-CN.md">简体中文</a>
</p>

# `apply_patch`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Performs multi-file Add, Update, Delete, and Move with a single freeform patch.

## Entry point

- Registration: [`src/apply-patch-tool.ts`](../../src/apply-patch-tool.ts)
- Parser/preflight/commit: [`src/apply-patch-core.ts`](../../src/apply-patch-core.ts)
- Display: [`src/apply-patch-display.ts`](../../src/apply-patch-display.ts)
- Grammar: [`src/apply-patch-grammar.ts`](../../src/apply-patch-grammar.ts)
- Schema: [`src/schemas/apply-patch.ts`](../../src/schemas/apply-patch.ts)
- Prompt: [`prompts/apply_patch.md`](../../prompts/apply_patch.md)

## Parameters

There is a single required string:

| Parameter | Description |
|------|------|
| `patchText` | The complete patch from `*** Begin Patch` to `*** End Patch` |

`workdir` is not a top-level JSON parameter; it is only available as an optional `*** Workdir:` directive inside the patch.

The tool provides an OpenAI Lark constrained sampling grammar to grammar-capable models.

## Patch structure

```text
*** Begin Patch
*** Workdir: optional/root
*** Add File: src/new.ts
+export const value = 1;
*** Update File: src/old.ts
*** Move to: src/new-name.ts
@@ optional context
-old
+new
*** End of File
*** Delete File: src/obsolete.ts
*** End Patch
```

Rules:

- Every line of an Add body starts with `+` and may be empty.
- Delete does not allow a body.
- An Update consists of one or more `@@` hunks.
- An Update may contain `*** Move to:`.
- A pure Move may have no hunks.
- Each path may appear only once within the same patch.

## Execution phases

```text
patchText
  -> normalize / heredoc unwrap
  -> parse
  -> resolve workdir and paths
  -> preflight every file
  -> identity/conflict checks
  -> acquire canonical path queues
  -> commit files in patch order
  -> LSP observers
  -> result metadata
```

## Parser

The parser handles:

- UTF BOM.
- LF, CRLF, CR.
- Whitespace at the Begin/End boundaries.
- `<<TOKEN`, `<<'TOKEN'`, `<<"TOKEN"` and heredoc wrappers with a `cat ` prefix.
- An optional `*** Workdir:`, allowed only right after Begin Patch.

Malformed patches fail before any filesystem access.

## Hunk matching

Update looks for a unique match in the following hierarchy:

1. `exact`
2. `trimEnd`
3. `trim`
4. `unicode`

The `unicode` tier applies the following normalizations:

- `‘`, `’`, `‚`, `‛` become `'`.
- `“`, `”`, `„`, `‟` become `"`.
- `‐`, `‑`, `‒`, `–`, `—`, `―`, `−` become `-`.
- `…` becomes `...`.
- Non-breaking space U+00A0 becomes a regular space.

Key rules:

- Every hunk must match uniquely.
- `@@ context` restricts the search starting point.
- Hunks are applied in source-file order.
- `*** End of File` requires the match at the end of the file.
- Hunks with only added lines are appended to the end of the file.
- Updates with no additions or deletions are rejected.

## Preflight

All files are preflighted first; if any item fails, no commit starts.

Preflight checks:

- The Add target must not exist.
- The Update/Delete source must exist and be a regular text file.
- Binary files are rejected.
- Neither the Move source nor the target may be a symlink.
- The Move target may only be a regular file or nonexistent.
- Paths must not resolve to the same canonical target.
- Checks inode/device identity and hardlink/symlink aliases.
- Checks output parent/child hierarchy conflicts.
- Verifies that encoding, BOM, line endings, and hunk results can be written back.

Preflight collects multiple independent errors and reports them together.

## Commit

Commits execute in the file order of the patch.

### Add

- Creates parent directories.
- Uses `wx` exclusive creation to prevent overwrite races.
- Non-empty content is joined with LF and a final newline is appended.
- An empty Add creates a zero-byte file.

### Update/Delete

Before committing, the current file is re-read and compared byte-wise with the preflight bytes. A stale patch is rejected when the file has changed.

- Update writes back to the original path.
- Delete uses `unlink`.

### Move

1. Re-checks the target state.
2. Creates the target parent directory.
3. Writes the target.
4. Restores the source mode.
5. Deletes the source file.

An existing regular target file may be overwritten.

## Partial commit

Preflight is exhaustive, but the commit is not a transaction.

If a later file fails during the commit phase:

- Previously successful files are not rolled back.
- Returns `partial: true`.
- `appliedFiles` lists the committed files.
- The failed path is marked `failedPathState: "unknown"`.
- On a mid-Move failure, neither the source nor the target can be assumed to retain its original state.

## Encoding and line endings

Update/Move preserve the existing file's:

- encoding
- BOM
- line endings
- final newline state

Add uses UTF-8/LF semantics.

## Permission

Permission resolves the patch intents first:

- A regular Update inherits `edit`.
- Add/Delete inherit `write`.
- Both the Move source and target inherit `write`.
- `permission.apply_patch` acts as an additional override layer.
- Multiple targets are aggregated as `deny > ask > allow`.

The permission prompt only shows the A/M/D operations and paths, without copying the patch body.

## LSP

After each successful commit:

- Add: sync the target.
- Update: sync the source.
- Delete: close the source document.
- Move: close the source and sync the target.

When a commit fails, the LSP document for the failed path is closed; on a Move failure, the document for the target path is closed as well.

## Diff and rendering

- File diff metadata keeps at most 400 displayed lines.
- Each line is at most 500 characters.
- `addedLines` / `removedLines` always count the complete diff.
- A settled Add body shows the first 10 lines by default, with at most 1500 characters per line.
- Malformed patches use a bounded raw preview.

## Related tests

- [`tests/apply-patch-core.test.ts`](../../tests/apply-patch-core.test.ts)
- [`tests/apply-patch-tool.test.ts`](../../tests/apply-patch-tool.test.ts)
- [`tests/apply-patch-display.test.ts`](../../tests/apply-patch-display.test.ts)
- [`tests/apply-patch-permission.test.ts`](../../tests/apply-patch-permission.test.ts)
- [`tests/apply-patch-context-compression.test.ts`](../../tests/apply-patch-context-compression.test.ts)
- [`tests/model-tool-routing.test.ts`](../../tests/model-tool-routing.test.ts)
- [`tests/tool-renderers.test.ts`](../../tests/tool-renderers.test.ts)
