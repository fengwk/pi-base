# `bash`

[← 工具索引](README.md) · [公共架构](../architecture.md)

## 作用

在指定工作目录运行 shell 命令，并流式收集 stdout/stderr。

## 入口

- 注册：[`src/bash-renderer-register.ts`](../../src/bash-renderer-register.ts)
- 子进程适配：[`src/bash-operations.ts`](../../src/bash-operations.ts)
- 调用/结果渲染：[`src/bash-renderer-core.ts`](../../src/bash-renderer-core.ts)
- Schema：[`src/schemas/bash.ts`](../../src/schemas/bash.ts)
- Prompt：[`prompts/bash.md`](../../prompts/bash.md)

## 参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `command` | 是 | — | shell 命令 |
| `workdir` | 否 | session cwd | 命令执行目录 |
| `timeout_seconds` | 否 | `120` | timeout 秒数 |

## 执行链

```text
解析 workdir
  -> 取得 cwd-scoped Bash tool
  -> timeout_seconds 映射为上游 timeout
  -> getShellConfig
  -> spawn shell
  -> stdout/stderr -> onData
  -> exit / timeout / abort
  -> Bash renderer
```

注册层复用 `@earendil-works/pi-coding-agent` 的 Bash tool contract，但注入本地 `createGracefulBashOperations`，以统一进程树终止和 inherited stdio 处理。

## Shell 选择

Shell 配置由 Pi 的 `getShellConfig` 决定。

Linux/macOS 下，当 `$SHELL` 是 Bash 或 Zsh 时，renderer 会构造 host shell options，加载常见 startup 文件：

- Bash：`.bash_profile`、`.bash_login`、`.profile`、`.bashrc`
- Zsh：`.zshenv`、`.zprofile`、`.zshrc`

Windows 使用平台默认 shell 配置。

某些 shell 配置通过 argv 传命令，另一些通过 stdin transport；本地 operations 同时支持两者。

## 子进程

- 非 Windows 使用 detached process group。
- stdout 和 stderr 都进入同一 `onData` 流。
- abort 和 timeout 都终止进程树。
- timeout 先触发 terminate，并可由通用 terminator 升级为强制 kill。
- 子进程退出后清理 timer、AbortSignal listener 和 stdio handle。

实现依赖 [`src/process-termination.ts`](../../src/process-termination.ts) 与内部 `waitForChildProcess` helper。

## Permission

Bash 不按路径匹配，而是先经过 [`src/bash-command-analyzer.ts`](../../src/bash-command-analyzer.ts)。

Analyzer 尝试拆分：

- `&&`
- `||`
- `|`
- `;`
- 换行

并识别引号、重定向、heredoc 和部分执行 wrapper。

动态命令头、命令替换、process substitution、控制流或无法保守分析的 shell 结构不会被当作已安全解析；如果没有明确 deny，则退回 `ask`。公共 Permission 边界见[架构说明](../architecture.md#路径与文件写入)。

## 结果与渲染

Bash renderer：

- 流式状态显示 elapsed time。
- 完成状态显示 total duration。
- 成功结果折叠时优先保留尾部输出。
- 错误即使配置为零行也保留有限诊断。
- 识别上游 `fullOutputPath` 和截断 footer，避免重复展示。

## Error

- spawn 错误转换为 `Error: ...`。
- timeout 在 operations 内使用 `timeout:<seconds>` marker，由上游 Bash tool 转换为用户结果。
- abort 使用 `aborted` marker。
- 非零命令退出由上游 Bash tool 返回退出码和输出。

## 相关测试

- [`tests/bash-index.test.ts`](../../tests/bash-index.test.ts)
- [`tests/bash-operations.test.ts`](../../tests/bash-operations.test.ts)
- [`tests/bash-renderer-behavior.test.ts`](../../tests/bash-renderer-behavior.test.ts)
- [`tests/bash-command-analyzer.test.ts`](../../tests/bash-command-analyzer.test.ts)
- [`tests/permission.test.ts`](../../tests/permission.test.ts)
- [`tests/process-termination.test.ts`](../../tests/process-termination.test.ts)
