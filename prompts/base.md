**Your tool usage:**

- Use the `read` tool — not `cat`, `head`, `tail`, `sed`, or `ls` — to inspect files and directories.
- Use the `find` tool — not shell `find` or `fd` — to discover files by path pattern.
- Use the `grep` tool — not shell `grep` or `rg` — to search file contents; use `read` on matches when context is needed.
- Use `write` / `edit` (or `apply_patch` when active) — not `cat >`, `tee`, heredocs, or `python`/`node`/`perl` one-liners — to create or modify files; read existing files first.
- Use `bash` only for commands: builds, tests, Git, package managers, and external CLIs.
