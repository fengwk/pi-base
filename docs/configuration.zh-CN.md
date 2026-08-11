<p align="center">
  🌐 <a href="configuration.md">English</a> · <a href="configuration.zh-CN.md">简体中文</a>
</p>

# 配置参考

完整示例见 [`examples/pi-base.json`](../examples/pi-base.json)。

## 配置文件

| 作用域 | 路径 |
|--------|------|
| 全局 | `~/.pi/agent/pi-base.json` |
| 项目 | 从 cwd 向上查找最近的 `<repo>/.pi/pi-base.json` |

环境变量 `PI_BASE_GLOBAL_SETTINGS_PATH` 可覆盖全局配置路径。

配置按 cwd 缓存在进程内。修改后执行 `/reload`。

## 校验

配置必须是 JSON object。顶层只允许：

- `lsp`
- `permission`
- `render`
- `notify`
- `yolo`
- `mcp`
- `compactionModel`
- `compactionThinkingLevel`
- `contextCompression`
- `subagent`
- `defaultAgent`

未知字段会报错，不会静默忽略。

## 合并规则

项目配置与全局配置按字段合并：

| 字段 | 规则 |
|------|------|
| `lsp.servers` | 项目声明 `servers` 时整体替换全局 server map |
| `permission` | 按 tool 合并规则数组，项目规则追加在全局规则之后 |
| `render` | 合并默认值和逐工具映射 |
| `notify` | 浅合并，项目字段覆盖全局字段 |
| `yolo` | 项目值覆盖 |
| `mcp.servers` | 按 server key 合并，同 key 项目覆盖 |
| `compactionModel` | 项目值覆盖 |
| `compactionThinkingLevel` | 项目值覆盖 |
| `contextCompression` | 标量逐项覆盖，数组整体替换 |
| `subagent` | 各字段逐项覆盖 |
| `defaultAgent` | 项目值覆盖 |

## `lsp`

```json
{
  "lsp": {
    "servers": {
      "typescript": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "firstMatchMarkers": [".git", "package.json", "tsconfig.json"],
        "requestTimeoutMs": 60000
      }
    }
  }
}
```

Server 字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `command` | 是 | 可执行文件和参数；首项必须在 PATH 或为绝对路径 |
| `extensions` | 是 | 负责的文件后缀 |
| `rootMarkers` | 否 | 多模块项目根标记，最顶层匹配优先 |
| `firstMatchMarkers` | 否 | 向上查找时首次匹配优先 |
| `requestTimeoutMs` | 否 | 每次请求超时，默认 60000 |
| `workspaceData` | 否 | jdtls workspace data 配置 |

`workspaceData`：

```json
{
  "mode": "stable",
  "baseDir": "/absolute/path/to/jdtls-workspaces"
}
```

- `stable`：同一项目使用稳定 hash 目录。
- `process`：目录名额外包含 PID。
- `disabled`：不自动添加 `-data`。

命令路径支持 `~/`、`$HOME/`、`${HOME}/`。其他环境变量不会插值。

## `permission`

支持 `allow`、`ask`、`deny`。

```json
{
  "permission": {
    "*": "allow",
    "edit": "ask",
    "write": "ask",
    "apply_patch": {
      "vendor/**": "deny",
      "*": "ask"
    },
    "bash": {
      "*": "ask",
      "git status*": "allow"
    }
  }
}
```

规则可以是字符串，也可以是 `pattern -> action` object。规则按顺序覆盖，最后一次匹配生效。

路径工具会同时考虑：

- 原始路径。
- 相对 workdir 的路径。
- 相对项目根的路径。
- 绝对路径。

`apply_patch` 会解析全部源路径和目标路径，并继承 edit/write 规则。Bash 使用静态命令分析；无法保守分析且未明确 deny 的命令会退回 `ask`。

Permission 用于防误操作，不是安全沙箱。

## `render`

```json
{
  "render": {
    "collapsedToolResultLines": {
      "*": 20,
      "read": 10,
      "grep": 15,
      "lsp_*": 5
    },
    "collapsedToolResultMaxChars": {
      "*": 10000,
      "bash": 4000
    }
  }
}
```

- 数字值表示全局默认。
- Object 支持精确工具名、通配符和 `*`。
- 匹配优先级：精确名 > 通配符 > `*`。
- 行数设为 0 会隐藏成功正文；错误仍保留有限诊断预览。

## `notify`

```json
{
  "notify": {
    "permissionAsked": true,
    "agentEnd": true,
    "suppressCompletedAfterRejectionMs": 5000
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `permissionAsked` | `false` | 权限确认前通知 |
| `agentEnd` | `false` | Agent run settled 为 completed 或 non-retryable error 时通知；active Goal continuation 不发送 completed 通知 |
| `suppressCompletedAfterRejectionMs` | `5000` | 拒绝权限后抑制 completed 通知 |

桌面通知支持 Linux desktop 和 WSL；其他平台不启用通知。

## `yolo`

Boolean，默认 `false`。启用后跳过 Permission guard。

`/yolo` 只切换当前进程内的运行时状态，不写回 JSON。

## `mcp`

### 本地 server

```json
{
  "mcp": {
    "startupTimeoutMs": 60000,
    "callTimeoutMs": 60000,
    "servers": {
      "local": {
        "type": "local",
        "command": ["my-mcp", "serve"],
        "cwd": "~/work/project",
        "env": {
          "API_KEY": "${API_KEY}"
        },
        "toolPrefix": "local"
      }
    }
  }
}
```

### 远程 server

```json
{
  "mcp": {
    "servers": {
      "docs": {
        "type": "remote",
        "transport": "streamable-http",
        "url": "https://example.com/mcp",
        "headers": {
          "Authorization": "${DOCS_TOKEN}"
        }
      }
    }
  }
}
```

支持 transport：

- `streamable-http`
- `sse`
- `websocket`

`env` 和 `headers` 只允许整个值引用 `$VAR` 或 `${VAR}`，不支持字符串内插。WebSocket transport 不支持自定义 headers。

`toolPrefix` 默认使用 server key；空字符串保留远端原始工具名。

## `subagent`

```json
{
  "subagent": {
    "maxDepth": 2,
    "maxConcurrency": 10,
    "maxTotalConcurrency": 20,
    "idleTimeoutMs": 300000,
    "maxTurns": 50
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `maxDepth` | `2` | root depth 为 1；达到上限不注入 `task` |
| `maxConcurrency` | `10` | 单父 session 的并发 child 上限 |
| `maxTotalConcurrency` | 未启用 | 整棵 delegation tree 并发上限 |
| `idleTimeoutMs` | 未启用 | 无 session 活动时的 timeout |
| `maxTurns` | `50` | 默认 soft-stop turn 预算 |

## `contextCompression`

默认关闭。未配置 `contextCompression` 时，不会替换任何历史工具结果。该功能在 provider request 前投影消息，用短占位文本替换符合条件的旧 `toolResult` 正文，以减少发送给模型的历史工具输出；它不生成对话摘要，也不扩大模型的 context window。

有两种独立的启用方式：

- `anchorHygiene: true`：文件被后续成功修改后，替换同一路径上更早的成功 `read`、`edit` 和 `apply_patch` 结果。失败结果和 `write` acknowledgement 不在此机制中替换。
- `tools` 使用非空数组：对列出的工具执行 age compression。只有同时满足保留窗口之外和工具名匹配的成功结果才会替换；skill 文件的 `read` 结果保留。

两项都未启用时，`contextCompression` 不生效。压缩只替换发送给模型的工具结果正文，不替换 user message、assistant message、tool call 参数或工具错误。模型需要旧结果细节时必须重新读取或重新执行工具，因此有副作用或成本较高的工具应谨慎加入 `tools`。

只在长时间、工具调用密集且已产生明确上下文压力的 session 中开启。短 session、仍需完整调试输出或不能安全重放命令的任务保持关闭。

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "tools": ["read", "grep", "find", "bash", "edit", "write", "apply_patch"],
    "retainedUserMessageRounds": 2,
    "retainedAssistantTurns": 4,
    "enabledProviders": ["openai"],
    "disabledProviders": ["xai"]
  }
}
```

- `anchorHygiene`：启用失效文件上下文清理；默认 `false`。
- `tools`：允许做 age compression 的工具名；缺失或空数组时关闭 age compression。
- `retainedUserMessageRounds` / `retainedAssistantTurns`：共同定义结果进入 age compression 范围的年龄阈值；启用 age compression 后默认值分别为 `2` 和 `4`。
- `enabledProviders`：仅列出的 provider 生效；空数组表示全部关闭。
- `disabledProviders`：明确排除 provider，不能是空数组。

## `compactionModel`

```json
{
  "compactionModel": "google/gemini-2.5-flash",
  "compactionThinkingLevel": "high"
}
```

`compactionModel` 必须使用 `provider/model` 格式。

Thinking level 可选值：

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`
- `max`

## `defaultAgent`

```json
{
  "defaultAgent": "reviewer"
}
```

Session 启动时的 Agent 选择优先级：

```text
当前 session 已持久化 Agent
  > --agent
  > defaultAgent
  > built-in default
```

第一项只在恢复或继承了 Agent state 的 session 中存在；全新 session 从 `--agent` 开始判断。
