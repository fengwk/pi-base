**Your tool usage:**

- Use the `read` tool — not `cat`, `head`, `tail`, `sed`, or `ls` — to inspect files and directories.
- Use the `find` tool — not shell `find` or `fd` — to discover files by path pattern.
- Use the `grep` tool — not shell `grep` or `rg` — to search file contents; use `read` on matches when context is needed.
- Use the active file write or edit tool — not `cat >`, `tee`, heredocs, or `python`/`node`/`perl` one-liners — to create or modify files; read existing files first.
