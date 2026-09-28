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

项目 `pi-base.json` 被视为可信运行时配置，不受 Pi project trust 状态限制。它可以定义可执行的 LSP 和 MCP 命令，因此只应在可信仓库中使用项目配置。

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

GNOME Wayland 下点击通知聚焦 tmux 终端，需要安装并启用上游 [Activate Window By Title](https://extensions.gnome.org/extension/5021/activate-window-by-title/)（UUID：`activate-window-by-title@lucaswerkmeister.de`），确认所安装版本支持当前 GNOME Shell（上游 v15 声明支持 45–51；安装前以扩展页面为准），并确保 `gdbus`、`notify-send` 和 `tmux` 可用。在**宿主 tmux** 设置：

```tmux
set -g set-titles on
set -g set-titles-string '#S:#I:#W [pi-tmux:#{pid}:#{client_pid}]'
```

终端还须将 tmux 设置的标题原样显示在 GNOME 窗口标题**末尾**。通知从 `TMUX_PANE` 的稳定 pane ID 追踪来源，该 pane 必须唯一属于一个 session（被链接到多个 session 时直接拒绝）。创建通知时脚本只记录快照：tmux server PID、来源 session，以及一份冻结且有序的附着 client 候选列表——先是在查看该 pane 的 client，其次是来源 session 中的 client，最后是同一 server 的其他 client，同优先级按数字 PID 升序打破平局。此阶段不激活、不切换任何对象。

点击后脚本先重新核验 tmux server 与来源 pane/session，再按顺序遍历冻结的候选列表：只考虑仍然存在且 tty、PID 均一致的 client；创建通知之后才附着的 client 永不会加入，已消失的候选则跳过并顺延到下一个捕获的候选。每个候选之前都会重新核验 server 与来源：已消失的候选跳过，而 server/来源变化则直接中止本次点击，绝不基于过期身份激活任何窗口。对每个候选，脚本通过扩展精确查找 `[pi-tmux:<server>:<client>]` 标题后缀，`(true,)` 表示存在携带该精确标题的本地窗口——这是“请求激活”，**不是**已观测到的焦点。SSH client 与本地共用同一 tmux server，但没有对应本地窗口，会返回 `(false,)`，因此被跳过且不会改动它的 session。只有在命中之后，脚本才重新核验来源与所选 client，仅切换该 client，按稳定 ID 选择捕获的 session/window/pane，并在再次核验 server、来源与 client 之后请求激活该窗口一次。由于 tmux session 共享 window/pane 选择，切换所选 client 可能改变同一 session 中其他 client 的显示内容，即使脚本从未对它们执行 `switch-client`。各失败阶段会分别输出简洁的 stderr 诊断——来源/来源 client 过期、无本地窗口匹配、D-Bus/扩展错误（含 gdbus 原始报错）、tmux 切换/选择失败——不会把所有错误都归结为“找不到标题”。D-Bus/扩展报错会立即中止，不会继续遍历剩余候选；标题稍有延迟时最多做 3 轮有界重试；存在多个本地匹配时按优先级与数字 PID 取第一个。

只要 server 至少有一个附着 client（包括仅有 SSH client）就会提供“切回并聚焦”动作：点击前无法枚举本地窗口——扩展只提供激活接口，`org.gnome.Shell.Introspect.GetWindows` 返回 `AccessDenied`，因此没有只读预检。这类点击可能以上述错误失败。非 tmux GNOME 或 server 没有任何 client 时只发送普通通知。`(true,)` 仅表示扩展找到了匹配窗口并调用激活，不保证实际焦点已可观测。终端不更新标题、扩展不可用或调用失败时不会回退到通用类名、X11 或 BEL attention；脚本会向 stderr 报错。

可在 Alacritty 中显式运行 `python3 scripts/test-gnome-focus.py --run` 做桌面冒烟验证：它在独立 tmux server 上打开三个临时窗口，其中两个共享同一 session 以覆盖候选优先级与数字 PID 选择，检查真实终端焦点事件和来源 pane 选中状态，结束后关闭测试窗口。该测试不代替实体通知点击，也不控制显示器布局；仍须将目标终端完全显示在另一屏幕上验证。

回滚时从宿主 tmux 配置移除上述两行，**还须在正在运行的 tmux server 中显式恢复事先保存的 `set-titles` 和 `set-titles-string` 原值**（例如使用 `tmux set -g`）；仅重新加载没有这两行的配置不会清除运行时选项。按需禁用扩展；不影响普通通知。WSL / X11 使用各自原有跳转方式。

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
