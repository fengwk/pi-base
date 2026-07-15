Edit one or more files in a single patch using the apply_patch tool.

The patch is a stripped-down, file-oriented diff format. Wrap every patch between these markers:

*** Begin Patch
*** End Patch

Between the markers, put one or more file operations. Each starts with a header:

*** Add File: <path>      Create a new file. Every content line starts with +.
*** Update File: <path>   Modify an existing file in place.
*** Delete File: <path>   Remove an existing file. No body follows.

## Updating a file

An Update contains one or more hunks. Each hunk starts with @@, optionally followed by a function or class name to help locate it:

@@ def greet():
 def greet():
-    print("Hi")
+    print("Hello, world!")

- Show 3 lines of context above and below each change, copied verbatim from the file.
- Context lines (copied from the file) start with a space. Removed lines start with -. Added lines start with +.
- Context and removed lines must match the current file exactly. Read the file before updating.
- If 3 lines are not enough to uniquely locate a change, add a @@ context line such as `@@ class Parser`.
- End a hunk at the end of the file with `*** End of File` on its own line.

## Examples

Create a new file:
*** Begin Patch
*** Add File: hello.txt
+Hello world
+Second line
*** End Patch

Update an existing file:
*** Begin Patch
*** Update File: src/app.py
@@ def greet():
 def greet():
-    print("Hi")
+    print("Hello, world!")
*** End Patch

Delete a file:
*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch

## Rules

- You MUST include a header (Add / Update / Delete) for every file operation.
- You MUST prefix every added line with +, including when creating a new file.
- Paths are relative to the working directory. Never use absolute paths.
- Each file may appear only once per patch.
- Add fails if the file already exists; it never overwrites. Delete and Update require an existing regular text file.
- An Update must change at least one line; a no-op update is rejected.
- `*** Move to:` is parsed for compatibility but Move is not supported; a patch containing it fails before any change.
- Put the patch text directly in patchText. Do not wrap it in Markdown fences or a second JSON object.
- File encoding, BOM, and line endings are preserved on Update.
- Files are checked before the first change. If a later file fails to commit, earlier files in the same patch may already be applied; the error reports which files were applied.

Parameters:
- patchText (required): the complete patch text.
