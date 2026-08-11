<p align="center">
  🌐 <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

# 配置示例

本目录提供可直接复制的 `pi-base.json` 和一组 Markdown Agent。`pi-base.json` 只包含不依赖本机可执行文件、服务地址、密钥或通知平台的配置。

## 复制到全局配置目录

Linux、macOS 或 WSL 在仓库根目录执行：

```bash
mkdir -p ~/.pi/agent/agents
cp examples/pi-base.json ~/.pi/agent/pi-base.json
cp examples/agents/*.md ~/.pi/agent/agents/
```

PowerShell：

```powershell
New-Item -ItemType Directory -Force "$HOME/.pi/agent/agents"
Copy-Item examples/pi-base.json "$HOME/.pi/agent/pi-base.json"
Copy-Item examples/agents/*.md "$HOME/.pi/agent/agents/"
```

这些文件组成一套可直接加载的全局配置。目标位置已有同名文件时，复制前先备份。Pi 已运行时，复制后执行 `/reload`。

| 示例文件 | 配置位置 |
|----------|----------|
| [`pi-base.json`](pi-base.json) | `~/.pi/agent/pi-base.json` 或项目的 `.pi/pi-base.json` |
| [`agents/*.md`](agents/) | `~/.pi/agent/agents/` |

## 已包含的配置

| 字段 | 示例值 | 行为 |
|------|--------|------|
| `defaultAgent` | `jiji` | 全新 session 没有持久化 Agent 且未通过 `--agent` 指定时选择 `jiji` |
| `permission` | 读取和搜索允许；文件修改询问；Bash 默认询问 | Git 状态、diff、log 和 show 命令直接允许，其他 Bash 命令进入权限确认 |
| `render` | 默认 10 行、Bash 20 行、最多 4000 字符 | 控制折叠工具结果的可见范围 |
| `subagent.maxDepth` | `3` | root session depth 为 1，最大委派深度为 3 |
| `subagent.maxConcurrency` | `4` | 每个 parent 同时运行最多 4 个直接 child |
| `subagent.maxTotalConcurrency` | `8` | 同一 root delegation tree 同时运行最多 8 个 Subagent |
| `subagent.idleTimeoutMs` | `120000` | Subagent 连续 120 秒没有 session 活动时终止 |
| `subagent.maxTurns` | `50` | 单次 `task` 未指定 `maxTurns` 时使用 50 turn soft-stop 预算 |

## Agent 模型

Agent 示例使用以下模型：

| Agent | Model | Thinking level |
|-------|-------|----------------|
| `jiji` | `openai/gpt-5.6-sol` | `max` |
| `coder` | `deepseek/deepseek-v4-flash` | `max` |
| `explorer` | `deepseek/deepseek-v4-flash` | `high` |
| `helper` | `deepseek/deepseek-v4-flash` | `high` |

模型存在且已配置认证时，Agent 会切换到表中的 model 和 thinking level；否则保留当前 session model 并产生警告。可以在各 Agent 文件的 frontmatter 中替换 `model` 和 `thinkingLevel`。

## 按需添加的配置

以下字段不写入可直接复制的 [`pi-base.json`](pi-base.json)：

| 字段 | 添加条件 |
|------|----------|
| `lsp` | 已安装对应 LSP server，并确认可执行文件路径、文件后缀和项目根标记 |
| `notify` | 运行环境是 Linux desktop 或 WSL，并需要权限或运行结束通知 |
| `mcp` | 已确定本地 server 命令或远程 server URL，以及所需环境变量 |
| `contextCompression` | 长时间、工具调用密集的 session 已产生明确的上下文压力，并且可以接受旧工具输出被占位文本替换 |
| `compactionModel` / `compactionThinkingLevel` | 已配置用于 context compaction 的 provider 和 model |
| `yolo` | 明确需要跳过 Permission guard；该配置会关闭操作确认 |

### LSP

`pi-base` 不内置 LSP server 表。`lsp.servers.<name>.command[0]` 必须是 `PATH` 中的命令或绝对可执行文件路径。命令不存在时配置文件仍可加载，但对应文件的 LSP 调用会返回 server 未安装错误。

以下模板覆盖 Java、TypeScript/JavaScript、Go 和 Python。只保留当前环境已经安装的 server，并根据项目结构调整 root markers：

```json
{
  "lsp": {
    "servers": {
      "jdtls": {
        "command": ["jdtls"],
        "extensions": [".java"],
        "rootMarkers": [
          "pom.xml",
          "build.gradle",
          "build.gradle.kts",
          "settings.gradle",
          "settings.gradle.kts"
        ],
        "firstMatchMarkers": [".git"],
        "requestTimeoutMs": 120000
      },
      "typescript-language-server": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".mts",
          ".cts"
        ],
        "firstMatchMarkers": [
          ".git",
          "package.json",
          "tsconfig.json",
          "jsconfig.json"
        ],
        "requestTimeoutMs": 90000
      },
      "gopls": {
        "command": ["gopls"],
        "extensions": [".go"],
        "firstMatchMarkers": [".git", "go.mod", "go.work"],
        "requestTimeoutMs": 90000
      },
      "pylsp": {
        "command": ["pylsp"],
        "extensions": [".py", ".pyi"],
        "firstMatchMarkers": [
          ".git",
          "pyproject.toml",
          "setup.py",
          "requirements.txt",
          "Pipfile"
        ],
        "requestTimeoutMs": 90000
      }
    }
  }
}
```

LSP 字段、workspace root 和 JDTLS workspace data 配置见[配置参考](../docs/configuration.zh-CN.md#lsp)。

### Notify

Linux desktop 或 WSL 可以添加：

```json
{
  "notify": {
    "permissionAsked": true,
    "agentEnd": true,
    "suppressCompletedAfterRejectionMs": 5000
  }
}
```

其他平台不启用桌面通知。

### MCP

本地 MCP server 需要配置 `type: "local"`、`command`，以及可选的 `cwd`、`env` 和 `toolPrefix`。远程 MCP server 需要配置 `type: "remote"`、`transport` 和 `url`。凭证通过完整值 `$VAR` 或 `${VAR}` 引用环境变量，不支持在字符串中插值，也不应直接写入配置文件。

本地和远程示例见 [MCP 配置参考](../docs/configuration.zh-CN.md#mcp)。

### Context compression

Context compression 默认关闭，不写入 [`pi-base.json`](pi-base.json)。它在向模型发送上下文前，用短占位文本替换符合条件的旧 `toolResult` 正文，从而减少请求中的历史工具输出；它不是对话摘要，也不会扩大模型的 context window。

支持两个独立机制：

- `anchorHygiene: true`：文件被后续成功修改后，替换同一路径上更早的成功 `read`、`edit` 和 `apply_patch` 结果。
- 非空 `tools`：对列出的工具执行 age compression。`retainedUserMessageRounds` 和 `retainedAssistantTurns` 共同定义结果进入压缩范围的年龄阈值，默认值分别为 `2` 和 `4`。

工具错误、user message、assistant message 和 tool call 参数不会被替换。启用后，模型需要旧输出细节时必须重新读取文件或重新执行工具；重新执行 Bash 等有副作用的命令可能不安全。因此只在长时间、工具输出较多且已出现上下文压力的 session 中开启。

可选配置：

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "tools": ["read", "grep", "find", "bash", "edit", "write", "apply_patch"],
    "retainedUserMessageRounds": 2,
    "retainedAssistantTurns": 4,
    "enabledProviders": ["openai"]
  }
}
```

只需要清理失效文件上下文时，可以仅设置 `anchorHygiene: true`；需要按年龄压缩工具输出时再添加 `tools`。Provider 过滤和字段语义见 [Context compression 配置参考](../docs/configuration.zh-CN.md#contextcompression)。

### Compaction model

需要独立 compaction model 时添加：

```json
{
  "compactionModel": "provider/model",
  "compactionThinkingLevel": "high"
}
```

`provider/model` 必须存在于 Pi 的模型配置中。

完整字段、默认值和合并规则见[配置参考](../docs/configuration.zh-CN.md)，Agent frontmatter 字段见[Markdown Agent](../docs/agents.zh-CN.md)。
