Edit one or more files in a single freeform patch.

Supply the complete protocol text directly as `patchText`; do not wrap it in Markdown fences.

Wrap every patch between these markers:

*** Begin Patch
*** End Patch

Optional first directive after Begin Patch (omit to use the session cwd):

*** Workdir: <path>

Between the markers, put one or more file operations. Each starts with a header:

*** Add File: <path>      Create a new file. Every content line starts with +; omit content lines to create an empty file.
*** Update File: <path>   Update an existing file, optionally writing the result to a new path.
*** Delete File: <path>   Remove an existing file. No body follows.

## Updating / moving a file

Place this optional directive immediately after an Update header to move the result:

*** Move to: <new path>

An in-place Update requires one or more hunks. A Move may omit hunks for a pure rename. Each hunk starts with @@, optionally followed by a search anchor such as a function or class name:

@@ def greet():
-    print("Hi")
+    print("Hello, world!")

- Text after @@ is a search anchor. Matching for that hunk starts after the anchor line; do not repeat the anchor as the first context line.
- Context lines start with a space. Removed lines start with -. Added lines start with +.
- Each search anchor and each context/removed sequence must identify exactly one location. Include enough surrounding context lines, copied verbatim from the file, to make the match unique; add more context or use a more specific anchor whenever the match would otherwise be ambiguous.
- Every @@ hunk must contain at least one context, removed, or added line.
- A hunk containing only added lines appends them at the end of the file. Include context or removed lines to edit a specific location.
- Put `*** End of File` after the final hunk when its match must end at the file tail; this also ends the Update body.
- Within an Update, a protocol-looking line prefixed with one space is context, not a file or patch boundary.
- Move writes the destination before removing the source. An existing regular destination file is overwritten.

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

Pure rename:
*** Begin Patch
*** Update File: src/old.py
*** Move to: src/new.py
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
- Every Update that contains hunks must add or remove at least one line; semantic no-ops are rejected.
- File encoding, BOM, and line endings are preserved on Update/Move content writes.
- Files are checked before the first change. If a later file fails to commit, earlier files in the same patch may already be applied; the error reports which files were applied.

Parameters:
- `patchText` (required): the complete freeform patch text from *** Begin Patch through *** End Patch.
