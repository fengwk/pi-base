Perform exact string replacements in a text file.

Usage:
- Prefer using `read` before editing an existing text file so you can copy the exact current text.
- `read` text output starts with a small header (`path`, `ends_with_newline`, and `lsp`), then a blank line, then numbered body lines in `number|content` form.
- When copying text from `read`, use only the file content after the first `|` on each numbered line. Never include the number column or the `|` itself in `old_string` or `new_string`.
- If `read` reports `ends_with_newline: yes`, remember that the file ends with a newline, even though `read` does not add an extra numbered blank line to represent it.
- Prefer `edit` for existing text files. Use `write` for new files or intentional whole-file replacement.
- The edit fails if `old_string` is not found in the file with an error "Could not find old_string".
- The edit fails if `old_string` is found more than once, reporting the match count as "Found N exact matches". Either provide a larger string with more surrounding context to make the match unique or use `replace_all` to change every instance of `old_string`.
- Use `replace_all` for file-wide exact renames or repeated replacements when every occurrence should change.
