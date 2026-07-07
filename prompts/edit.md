Performs exact string replacements in files.

Usage:
- Prefer using `read` before editing an existing text file so you can copy the exact current text.
- `read` text output starts with metadata lines (`path`, `kind`, `encoding`, `bom`, `line_endings`, `final_newline`), then a blank line, then numbered body lines. Only the numbered body is file content.
- When editing text from `read` tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g. `1: `). Everything after that space is the actual file content to match. Never include any part of the line number prefix in oldString or newString.
- If `read` reports `final_newline: yes`, remember that the file ends with a newline even though the numbered body does not include an extra trailing empty line just to show it.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if `oldString` is not found in the file with an error "Could not find oldString".
- The edit will FAIL if `oldString` is found multiple times in the file with an error "Found multiple exact matches". Either provide a larger string with more surrounding context to make the match unique or use `replaceAll` to change every instance of `oldString`.
- Use `replaceAll` for replacing and renaming strings across the file. This parameter is useful for renaming a variable for instance.

Parameters:
- `path` (required): path to the file to edit (relative or absolute).
- `oldString` (required): exact text to replace. Must match exactly as shown in file content, including whitespace and indentation. Must be unique in the file unless `replaceAll` is true.
- `newString` (required): replacement text (must differ from `oldString`).
- `replaceAll` (optional, default false): replace all exact occurrences of `oldString`.
- `workdir` (optional, default: the agent's current working directory; if provided, resolve relative paths from that directory).
