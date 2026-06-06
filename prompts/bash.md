Run build, test, git, package-manager, move/copy, and external CLI commands.

Environment:
- OS: ${os}
- Shell: ${shell}
- Note: ${osNote}

Usage:
- Use `bash` for commands, not as the normal way to read, search, or edit repository files.
- Pass `workdir` on every `bash` call. Use `workdir` to choose the execution directory instead of embedding `cd ... &&` in `command`.
- On Linux, WSL, and macOS, `bash` prefers the host shell when `$SHELL` is `bash` or `zsh`, and loads common startup files to better match the terminal environment.
- If a command will create files or directories, first confirm the target parent location with the file tools.
- Quote file paths that contain spaces.
- When commands are independent, prefer separate parallel tool calls. When one shell step depends on a previous step, chain them with `&&`; use `;` only when failure of earlier steps does not matter.
- Use a temporary directory outside the repository for downloads, generated artifacts, temporary clones, and other non-target side effects unless the user explicitly wants files created in the project.

Parameters:
- `command` (required)
- `workdir` (required)
- `timeout_seconds` (optional, no default)

Examples show the arguments passed to the tool:
- `{"command":"npm test","workdir":"packages/web"}`
- `{"command":"mvn -q test","workdir":"services/java","timeout_seconds":120}`
- `{"command":"git status --short","workdir":"."}`
- `{"command":"mkdir -p build && cp \"source file.txt\" build/","workdir":"packages/app"}`
- `{"command":"mv src/old.ts src/archive/old.ts","workdir":"services/api"}`
- `{"command":"cp \"source file.txt\" \"target file.txt\"","workdir":"/tmp/anydir"}`
