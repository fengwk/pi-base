Run build, test, git, package-manager, move/copy, and external CLI commands.

Environment:
- OS: ${os}
- Shell: ${shell}
- Note: ${osNote}

Usage:
- Use `bash` for commands, not as the normal way to read, search, or edit repository files.
- `workdir` defaults to the agent's current working directory. If `workdir` is provided, the command runs from that directory. Prefer `workdir` over embedding `cd ... &&` inside `command` when you need a different directory.
- On Linux, WSL, and macOS, `bash` prefers the host shell when `$SHELL` is `bash` or `zsh`, and loads common startup files to better match the terminal environment.
- Long-running commands (e.g. builds, tests, large migrations, `mvn`, `gradle`, `docker build`) must explicitly pass a larger `timeout_seconds` if they may exceed the default. On timeout the command is asked to terminate first, then force-killed if it does not exit within a short grace period.
- If a command will create files or directories, first confirm the target parent location with the file tools.
- Quote file paths that contain spaces.
- When commands are independent, prefer separate parallel tool calls. When one shell step depends on a previous step, chain them with `&&`; use `;` only when failure of earlier steps does not matter.
- Use a temporary directory outside the repository for downloads, generated artifacts, temporary clones, and other non-target side effects unless the user explicitly wants files created in the project.

Parameters:
- `command` (required)
- `workdir` (optional, default: the agent's current working directory; if provided, run in that directory; prefer it over `cd ... &&` in `command`)
- `timeout_seconds` (optional, defaults to 120 = 2 minutes). For long-running commands, explicitly provide a larger value.

Examples use pseudo-code tool calls:
- `bash({ command: "npm test", workdir: "packages/web" })`
- `bash({ command: "mvn -q test", workdir: "services/java", timeout_seconds: 120 })`
- `bash({ command: "git status --short" })`
- `bash({ command: "mkdir -p build && cp \"source file.txt\" build/", workdir: "packages/app" })`
- `bash({ command: "mv src/old.ts src/archive/old.ts", workdir: "services/api" })`
- `bash({ command: "cp \"source file.txt\" \"target file.txt\"", workdir: "/tmp/anydir" })`
