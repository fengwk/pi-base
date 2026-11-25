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

项目 `pi-base.json` 被视为可信运行时配置，不受 Pi project trust 状态限制。它可以定义可执行的 LSP 命令，因此只应在可信仓库中使用项目配置。（MCP server 改在 `.pi/mcp.json` 或 `~/.pi/agent/mcp.json` 中配置，遵循 Pi 原生可信项目安全模型）。

## 校验

配置必须是 JSON object。顶层只允许：

- `lsp`
- `permission`
- `toolModels`
- `render`
- `notify`
- `yolo`
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
| `toolModels` | 对项目配置中列出的每个工具，项目白名单整体替换全局白名单 |
| `render` | 合并默认值和逐工具映射 |
| `notify` | 浅合并，项目字段覆盖全局字段 |
| `yolo` | 项目值覆盖 |
| `compactionModel` | 项目值覆盖 |
| `compactionThinkingLevel` | 项目值覆盖 |
| `contextCompression` | 标量逐项覆盖，数组整体替换 |
| `subagent` | 各字段逐项覆盖 |
| `defaultAgent` | 项目值覆盖 |

> **注意**：MCP 已不再在 `pi-base.json` 中配置。Pi 原生 MCP 使用 `~/.pi/agent/mcp.json` 或 `.pi/mcp.json`（标准 `mcpServers` 格式）。已有配置迁移见 [MCP 迁移指南](mcp-migration.zh-CN.md)。

## `toolModels`

```json
{
  "toolModels": {
    "web_search": ["xai/grok-4.7", "google/gemini-4-*"],
    "url_context": []
  }
}
```

键是 Pi 中注册的工具名，必须精确匹配。未列出的工具不受影响，空数组对所有模型禁用该工具。数组中的模式按大小写匹配当前模型的完整 `provider/model` 标识；`*` 匹配零个或多个字符。

模型匹配时，pi-base 会直接添加已注册的 `direct` 和 `model-only` 工具，无需在 Agent 的 `tools:` 里重复填写。不匹配时，工具不会显示，且即使已列在 `tools:` 或开启 YOLO 模式也不能调用。切换模型和 Subagent 会话同样适用。

这项配置不会安装工具、探测服务商是否支持、自动加载 `codemode` 或 `deferred` 工具，也不绕过权限规则。`task` 和 Goal 等由 runtime 管理的工具仍有自己的启用条件，模型规则只能进一步限制它们。

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

Bash 使用静态命令分析；无法保守分析且未明确 deny 的命令会退回 `ask`。

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

桌面通知支持 Linux 和 WSL。tmux 跳转使用稳定 ID，按 session → window → pane 比较所选 client 的当前状态，只切换不同的层级。失败时停止，成功前核对同一个 client 实际显示的内容。tmux 的窗口和 pane 选择是共享的，同一个 session 或显示同一个链接窗口的其他 client 也可能看到变化，但不会被切换到另一个 session。

### GNOME Wayland

安装并启用适合当前 GNOME Shell 版本的 [Activate Window By Title](https://extensions.gnome.org/extension/5021/activate-window-by-title/)（`activate-window-by-title@lucaswerkmeister.de`）。聚焦动作需要 `tmux`、`gdbus` 和带 PyGObject 的 `python3`（Ubuntu 上的 `python3-gi`）；Linux 通知还需要 `notify-send`。在**宿主 tmux** 配置中添加：

```tmux
set -g set-titles on
set -g set-titles-string '#S:#I:#W [pi-tmux:#{pid}:#{client_pid}]'
```

终端必须把 `[pi-tmux:<server>:<client>]` 后缀保留在 GNOME 窗口标题的**末尾**。点击通知正文即可跳转。脚本用同一个 D-Bus 连接发送通知并等待点击，以接收 GNOME 发回给通知发送方的动作信号。通知关闭或等待超过 `PI_NOTIFY_ACTION_TIMEOUT_SEC` 秒（默认 `600`）后，点击不会再跳转。缺少 PyGObject、通知服务不支持动作，或没有安全的 tmux 目标时，只发送普通通知。

发通知时，Pi 记录来源 server、pane、session 和候选 client。优先选正在查看来源 pane 的 client，其次选来源 session 的其他 client，同级按数字 PID 排序。如果当时只有一个 client 在来源 session 之外，才把它作为回退。已记录的 client 换了 session 仍可跳回；之后才附着或复用旧 tty 的 client 不参与。来源 pane 必须唯一属于原 session，但可以在该 session 内移动到另一个窗口。

点击后，扩展必须匹配候选窗口的精确标题后缀，脚本才会切换 tmux。没有本地窗口的 SSH client 会被跳过。跳转后脚本再次请求激活终端；扩展匹配只表示已请求激活，不等于确认了焦点。目标过期、找不到窗口、激活失败或 tmux 切换失败时，脚本会向 stderr 报告失败阶段。

在 Alacritty 中运行 `python3 scripts/test-gnome-focus.py --run` 可以做聚焦冒烟验证。它在独立 tmux server 上打开临时窗口，检查实际焦点和选中的 pane；它不测试桌面通知点击。

回滚时移除 tmux 配置中的两行，并**在运行中的 tmux server 上恢复原来的 `set-titles` 和 `set-titles-string` 值**。仅重载配置不会清除旧值。禁用扩展后仍可接收普通通知。

### WSL 和其他 Linux 桌面

WSL 使用 Windows 通知；其他 Linux 桌面继续通过 `notify-send` 提供 Jump 动作，不需要 PyGObject。跳转在记录的 tmux server 上按 pane ID 查找来源，窗口重编号或 pane 移动后仍可定位。若 pane 同时链接到多个 session、却已不在原 session 中，脚本会停止而不是猜测。优先使用记录的终端，其次选目标 session 的 client；否则只在剩一个终端 client 时回退，不在多个无关终端中猜测。旧 Windows 通知携带的 `session:window.pane` 仍可使用，前提是名称和序号没有变化。

## `yolo`

Boolean，默认 `false`。启用后跳过 Permission guard。

`/yolo` 只切换当前进程内的运行时状态，不写回 JSON。

## `mcp`（原生 MCP）

MCP 单独配置在 `~/.pi/agent/mcp.json` 中，可信项目也可使用 `.pi/mcp.json`。
项目条目会替换同名全局条目。它不再是 `pi-base.json` 字段，
应使用显式 `direct` 暴露：

```json
{
  "mcpServers": {
    "local-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "exposure": "direct"
    },
    "remote-server": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_TOKEN}"
      },
      "timeout": 60,
      "exposure": "direct"
    }
  }
}
```

`command` 和 `args` 配置 stdio，`url` 配置 streamable HTTP。
`timeout` 单位为秒。不要将明文凭证提交到配置文件中。
`exposure: "direct"` 与 `codemode` 注册或激活独立。
原生发现扩展及 `defaultTools` 在 Pi 的 `settings.json` 中配置，
不是新增的 `pi-base.json` 字段；启用 `codemode` 并禁用 tool search
见 [Pi 1.0 settings 示例](tools/mcp.zh-CN.md#原生发现配置)。
Agent 策略和 session 行为见[原生 MCP 工具](tools/mcp.zh-CN.md)，
一次性迁移 CLI 与安全规则见[迁移指南](mcp-migration.zh-CN.md)。

## `subagent`

```json
{
  "subagent": {
    "maxDepth": 2,
    "maxConcurrency": 10,
    "maxTotalConcurrency": 20,
    "idleTimeoutMs": 300000,
    "modelMaxRetries": 2,
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
| `modelMaxRetries` | 继承 Pi `retry.maxRetries` | 每个 delegated session 的模型调用自动重试上限；设为 `0` 可禁用 |
| `maxTurns` | `50` | 默认 soft-stop turn 预算 |

## `contextCompression`

默认关闭。未配置 `contextCompression` 时，不会替换任何历史工具结果。该功能在 provider request 前投影消息，用短占位文本替换符合条件的旧 `toolResult` 正文，以减少发送给模型的历史工具输出；它不生成对话摘要，也不扩大模型的 context window。

有两种独立的启用方式：

- `anchorHygiene: true`：文件被后续成功修改后，替换同一路径上更早的成功 `read` 和 `edit` 结果。失败结果和 `write` acknowledgement 不在此机制中替换。
- `tools` 使用非空数组：对列出的工具执行 age compression。只有同时满足保留窗口之外和工具名匹配的成功结果才会替换；skill 文件的 `read` 结果保留。

两项都未启用时，`contextCompression` 不生效。压缩只替换发送给模型的工具结果正文，不替换 user message、assistant message、tool call 参数或工具错误。模型需要旧结果细节时必须重新读取或重新执行工具，因此有副作用或成本较高的工具应谨慎加入 `tools`。

只在长时间、工具调用密集且已产生明确上下文压力的 session 中开启。短 session、仍需完整调试输出或不能安全重放命令的任务保持关闭。

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "tools": ["read", "grep", "find", "bash", "edit", "write"],
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

自定义压缩通过当前 session 的 model registry 发起流式请求，保留 provider 的请求时鉴权和配置的 endpoint/header，不会把已解析的 OAuth token 作为显式 API key 再次传入。模型不可用或请求失败时，pi-base 会告警并回退到 Pi 当前模型的压缩路径。

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
