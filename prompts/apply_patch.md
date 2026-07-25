Edit one or more files in a single freeform patch using the apply_patch tool.

This is a FREEFORM tool: put the complete patch text in `patchText`. Do not wrap the patch in a second JSON object.

The patch is a stripped-down, file-oriented diff format (Codex apply_patch). Wrap every patch between these markers:

*** Begin Patch
*** End Patch

Optional first directive after Begin Patch (pi-base extension; omit to use the session cwd):

*** Workdir: <path>

Between the markers, put one or more file operations. Each starts with a header:

*** Add File: <path>      Create a new file. Every content line starts with +.
*** Update File: <path>   Modify an existing file in place (optionally with Move).
*** Delete File: <path>   Remove an existing file. No body follows.

## Updating / moving a file

An Update may include:

*** Move to: <new path>

then zero or more hunks. Each hunk starts with @@, optionally followed by a function or class name:

@@ def greet():
 def greet():
-    print("Hi")
+    print("Hello, world!")

- Show 3 lines of context above and below each change, copied verbatim from the file.
- Context lines start with a space. Removed lines start with -. Added lines start with +.
- Context and removed lines must match the current file exactly. Read the file before updating.
- If 3 lines are not enough to uniquely locate a change, add a @@ context line such as `@@ class Parser`.
- End a hunk at the end of the file with `*** End of File` on its own line.
- Move may be content-only rename (no hunks) or rename plus content updates.
- An existing destination file is overwritten on Move (Codex semantics).

## Examples

Create a new file:
*** Begin Patch
*** Add File: hello.txt
+Hello world
+Second line
*** End Patch

Update in a workspace worktree without changing session cwd:
*** Begin Patch
*** Workdir: .workspace/my-task/worktree
*** Update File: src/app.py
@@ def greet():
 def greet():
-    print("Hi")
+    print("Hello, world!")
*** End Patch

Rename and update:
*** Begin Patch
*** Update File: src/old.py
*** Move to: src/new.py
@@
-old
+new
*** End Patch

Delete a file:
*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch

## Rules

- You MUST include a header (Add / Update / Delete) for every file operation.
- You MUST prefix every added line with +, including when creating a new file.
- Paths are relative to `*** Workdir:` when present, otherwise the agent's current working directory. Prefer relative paths; avoid absolute file paths.
- When other tools used a workspace workdir, put the same root in `*** Workdir:` and keep patch paths relative to it.
- Each file path may appear only once per patch (including Move destinations).
- Add fails if the file already exists; it never overwrites. Delete and Update require an existing regular text file at the source path.
- An in-place Update (no Move) must change at least one line; a no-op update is rejected.
- File encoding, BOM, and line endings are preserved on Update/Move content writes.
- Files are checked before the first change. If a later file fails to commit, earlier files in the same patch may already be applied; the error reports which files were applied.

Parameters:
- `patchText` (required): the complete freeform patch text from *** Begin Patch through *** End Patch.
