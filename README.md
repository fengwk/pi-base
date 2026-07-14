# pi-base

`pi-base` 是 Pi 的基础扩展包，提供文件工具、`bash`、LSP、MCP、权限控制、通知，以及基于 Markdown 的 agent 系统。它不是独立应用，通过 Pi 的扩展机制加载。

## 目录

- [快速开始](#快速开始)
- [工具](#工具)
- [Agent](#agent)
- [配置](#配置)
- [命令](#命令)
- [运行时行为](#运行时行为)
- [开发](#开发)

## 快速开始

### 配置文件

| 作用域 | 路径 |
|--------|------|
| 全局 | `~/.pi/agent/pi-base.json` |
| 项目 | `<repo>/.pi/pi-base.json`（向上查找最近祖先） |

最小配置为空对象 `{}`。隔离测试可用环境变量覆盖全局路径：`PI_BASE_GLOBAL_SETTINGS_PATH=/tmp/pi-base.json`。

修改配置后执行 `/reload` 重新加载。

### 安装

```bash
# 作为 Pi package 安装（推荐，支持自动加载、/reload 和 task 子 agent）
# 或仅从源码入口启动：
pi -e /path/to/pi-base/index.ts
```

`pi -e` 只把源码扩展加载到当前 session；`task` 创建的默认 Pi 子 session 不继承该 flag。需要使用 `task` 时，必须通过 Pi package（推荐）或持久扩展配置让父子 session 从同一加载路径复用同一 `pi-base` 模块实例；否则会 fail-fast，而不会在进程级 registry/permission host 断开的情况下继续运行。若已配置相同路径但缓存曾被其他工作区刷新，请 reload 或重启父 session。

### 启动 Agent 选择

```
session 已持久化的 agent  >  --agent <name>  >  pi-base.json.defaultAgent  >  default
```

`default` 复用 `~/.pi/agent/SYSTEM.md` + `settings.json` 的默认 provider/model/thinkingLevel。

---

## 工具

启动时 `pi-base` 确保以下 9 个基础工具可用。残留的已退役 `task` 自动移除。

### 工具速查

| 工具 | 必填参数 | 默认值 | 关键行为 |
|------|----------|--------|----------|
| `read` | `path` | offset=1, limit=200 (max 2000) | 文本文件返回 `行号|内容` 格式头部标注 path/ends_with_newline/lsp；目录列出排序成员；图片返回附件（模型不支持时给出 skill 提示）；二进制直接报错；UTF BOM/编码探测 + LF 规范化；单行 >2000 字符截断标记 |
| `grep` | `pattern`, `path` | timeout=15s, limit=100 | 支持 `include`/`ignore_case`/`literal`/`multiline`；二进制文件报错；结果行 >500 字符截断；输出是候选位置，编辑前先 `read` |
| `find` | `pattern`, `path` | limit=1000, 无默认超时 | `path` 无隐式默认值，搜当前目录需显式写 `"."`；底层使用 `fd` |
| `bash` | `command` | timeout=120s | 使用 `$SHELL`（bash/zsh）并加载 rc 文件；优先用 `workdir` 切换目录 |
| `edit` | `path`, `old_string`, `new_string` | — | 精确文本替换；基于 LF 视图匹配，按原 BOM/编码/换行回写；支持 `replace_all`；成功返回 diff 预览 |
| `write` | `path`, `content` | — | 新文件/整文件覆盖；自动创建父目录；覆盖时沿用原编码/BOM，换行按 `content` 原样写入；新文件默认 UTF-8 |
<!-- 暂时禁用；恢复注册时一并取消此注释。
| `lsp_diagnostics` | `path` | severity=all | 需 `lsp.servers` 声明 server；不做能力前置检查 |
-->
| `lsp_goto_definition` | `path`, `line` | character=0 | 需 server 声明 `textDocument/definition` |
| `lsp_workspace_symbols` | `path`, `query` | limit=50 | 需 server 声明 `workspace/symbol` |
| `lsp_java_decompile` | `path`, `target` | — | 需 server 支持 `java/classFileContents`（通常 jdtls） |

`lsp_diagnostics` 在 0.1.x 期间暂时禁用评估；下一个 minor release 前必须明确恢复注册或完整删除其实现。

### `task`（子 agent 委派）

仅当 agent 配置了 `subagents` allowlist 且 session depth < `subagent.maxDepth` 时注入。

| 参数 | 说明 |
|------|------|
| `subagent_type` (必填) | 委派的目标 agent 名 |
| `prompt` (必填) | 委派任务的完整描述 |
| `session_id` (可选) | 恢复已有子 session |

返回 XML 格式结果：

```
<task id="session-id" state="completed">
<task_result>Agent 最终报告</task_result>
</task>
```

并发限制：`subagent.maxConcurrency`（单父 session）+ `subagent.maxTotalConcurrency`（整棵 delegation tree）。从 `pi -e` 源码模式启动时，子 session 仍须从持久配置复用父 session 的同一 `pi-base` 模块实例，否则会明确报错并安全退出。

### MCP 工具

`mcp.servers` 中连接的 server 自动注册工具：

- 默认别名：`<serverKey>_<toolName>`
- `toolPrefix: ""` 保留远端原始 tool 名
- agent 有 `tools` allowlist 时，仅 allowlist 中的 MCP alias 生效
- 同名冲突时工具不注册，`/mcp-status` 显示冲突原因

### LSP 工具

全部通过 `lsp.servers` 显式声明，`pi-base` 不内置 server 表。后缀未命中任何 server → `No LSP server configured for ...`。

LSP client 在进程内共享，由单个活跃 root session 管理；headless subagent 复用 root client，不独立关闭。当前不支持同一进程同时运行多个 UI root session。

---

## Agent

Agent 定义在 `~/.pi/agent/agents/**/*.md`，`pi-base` 递归扫描。`default` 是保留名（不能用于文件），正文为空时回退到 `~/.pi/agent/SYSTEM.md`。

### Frontmatter 字段

```md
---
name: planner
description: Planning-focused agent
model: provider/model-id          # 仅切换时 best-effort 应用
thinkingLevel: high               # off|minimal|low|medium|high|xhigh|max；仅切换时 best-effort 应用
tools: [read, grep]               # allowlist；未配置=全部可用；[]=全部禁用
skills: [spec]                    # allowlist；未配置=全部注入；[]=全部禁用
subagents: [reviewer]             # allowlist；非空 + depth<maxDepth → 注入 task 工具
---

Agent 正文（覆盖 system prompt）
```

### 行为规则速查

| 维度 | 规则 |
|------|------|
| prompt | agent 正文非空覆盖 system prompt；空则回退 Pi customPrompt；都没有保留 Pi 预构建兜底 |
| model / thinkingLevel | 仅显式切换时 best-effort 应用；resume/reload 不覆盖 session 的值；失败输出 warning 不阻塞切换 |
| tools | allowlist 机制；LSP/MCP 工具同样受控；task 工具由 subagents + depth 动态注入 |
| skills | allowlist 过滤后统一重建 prompt；仅 `read` 可用时注入 `<available_skills>`；`disable-model-invocation` skill 不暴露给模型；不影响 `/skill:name` |
| subagents | 不存在的 agent 从 allowlist 剔除并 warning；非空 + depth<maxDepth → 注入 task 并在 prompt 中以 `<available_subagents>` XML 列出 |
| session 恢复 | 最近一次 `/agent` 写入 session entry；下次 `session_start` 自动恢复；已持久化 agent 不存在时回退 default |
| 启动顺序 | 已持久化 agent > `--agent` > `defaultAgent` > `default`；`/agent default` 不重置 model/thinkingLevel |

### 切换

| 命令 | 效果 |
|------|------|
| `/agent planner` | 切换到指定 agent，应用 model/thinkingLevel + 写 session entry |
| `/agent default` | 切回默认 agent |
| `/agent` | 有 UI 时弹选择器；无 UI 需显式带名字 |

---

## 配置

`pi-base.json` 顶层字段：

| 字段 | 类型 | 用途 |
|------|------|------|
| `lsp` | object | LSP server 列表 |
| `permission` | object / string | 工具执行策略 |
| `render` | object | 结果折叠预览控制 |
| `notify` | object | 桌面通知开关 |
| `yolo` | boolean | 权限绕过模式 |
| `mcp` | object | MCP server 列表 |
| `contextCompression` | object | 旧工具输出压缩 |
| `subagent` | object | task 委派深度/并发/超时 |
| `defaultAgent` | string | fresh session 默认 agent |

常见配置起点：

```json
{
  "permission": { "edit": "ask", "write": "ask", "bash": { "*": "ask", "git *": "allow" } },
  "lsp": { "servers": { "ts": { "command": ["typescript-language-server", "--stdio"], "extensions": [".ts", ".tsx", ".js", ".jsx"] } } },
  "notify": { "permissionAsked": true, "agentEnd": true }
}
```

### 全局/项目配置合并规则

| 字段 | 合并方式 |
|------|----------|
| `lsp.servers` | 项目出现 `servers` → 整体替换全局，不深合并 |
| `permission` | 按 tool 名追加合并，最后匹配的规则生效 |
| `render` | 合并；全局单个数字当作 `"*"` 默认值，再叠加项目细粒度规则 |
| `notify` | 浅覆盖，项目只覆盖自己声明的字段 |
| `yolo` | 项目值直接覆盖 |
| `mcp.servers` | 按 key 合并；同 key 项目覆盖全局 |
| `contextCompression` | 标量逐个覆盖；`tools`/`enabledProviders`/`disabledProviders` 数组替换不追加 |
| `subagent` | 各字段浅覆盖；未配置的继承全局 |
| `defaultAgent` | 项目值直接覆盖 |

### 配置参考

#### `lsp`

完全用户定义，`pi-base` 不内置 server 表。禁用某个 server 直接从 map 中移除即可。

```json
{
  "lsp": {
    "servers": {
      "ts": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "firstMatchMarkers": [".git", "package.json", "tsconfig.json"]
      },
      "jdtls": {
        "command": ["$HOME/.local/share/nvim/mason/bin/jdtls"],
        "extensions": [".java"],
        "rootMarkers": ["pom.xml", "build.gradle"],
        "workspaceData": { "mode": "process" }
      },
      "gopls": {
        "command": ["gopls"],
        "extensions": [".go"],
        "firstMatchMarkers": [".git", "go.mod"],
        "requestTimeoutMs": 60000
      }
    }
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `command` | ✅ | `command[0]` 必须是 PATH 命令或绝对路径（支持 `~/`、`$HOME/`、`${HOME}/`）。不支持任意环境变量展开 |
| `extensions` | ✅ | 负责的文件后缀 |
| `rootMarkers` | ❌ | 多模块项目根标记，最顶层匹配优先 |
| `firstMatchMarkers` | ❌ | 备选根标记，首次匹配优先。与 rootMarkers 并存时优先 rootMarkers |
| `requestTimeoutMs` | ❌ | 默认 `60000` |
| `workspaceData` | ❌ | 仅 jdtls；`mode`: `stable`(默认) / `process`(per-PID) / `disabled`；`baseDir` 改写生成目录父目录，需绝对路径 |

缺失可执行文件时返回带 `pi-base.json` 片段的错误提示。jdtls 自动追加 `-data ~/.cache/jdtls-workspace/<md5>`。

#### `permission`

`allow` / `ask` / `deny` 三态模型。

```json
{
  "permission": {
    "*": "allow",
    "edit": "ask",
    "bash": { "*": "ask", "git *": "allow", "npm test": "deny" }
  }
}
```

| 规则 | 说明 |
|------|------|
| 整体字符串 | 作用于所有工具 |
| 单 tool 字符串 | 该工具固定策略 |
| 单 tool 对象 | 按 wildcard pattern 匹配 command/路径 |
| 默认行为 | 未匹配任何规则时为 `allow`；需要默认确认时显式配置 `"*": "ask"` |
| 匹配顺序 | 先检查全局 `*`，再检查 tool 专属规则；最后匹配的规则生效 |
| `ask` | 有 UI 弹出 Yes/No；无 UI headless subagent 转发给 root UI；其他无 UI 场景直接拦截 |
| 路径类匹配 | 同时匹配原始路径、相对 workdir 路径、相对项目根路径、绝对路径 |
| bash 匹配 | 识别 `&&`/`||`/`|`/`;`/换行 分割的顶层 command 段；不展开变量；动态命令头、命令头/前置重定向、复合/控制流语法、命令替换、可展开 heredoc、process substitution、shell/eval/source 动态执行，以及 command/env/exec/nohup 执行包装器无法保守分析时，显式整条命令 deny 仍 deny，否则退回 ask |

`permission` 是用于防误操作的词法规则，不是安全沙箱。它不会执行完整 shell 解析或提供文件系统隔离；文件路径检查也不防御 symlink 穿透或 TOCTOU 竞态。需要强隔离时应在 Pi 之外使用容器、受限账户或其他系统级沙箱。

配置按 cwd 缓存在当前进程中；修改全局或项目配置后执行 `/reload` 才会生效。

#### `yolo`

布尔值，默认 `false`。`/yolo` 切换当前进程状态，不回写配置文件。工作区首次载入时用配置值设初值。

#### `render`

控制工具结果折叠预览。

```json
{
  "render": {
    "collapsedToolResultLines": { "*": 20, "read": 10, "grep": 15, "lsp_*": 5, "edit": 0 },
    "collapsedToolResultMaxChars": { "*": 10000, "bash": 4000, "web_search": 1200 }
  }
}
```

| 字段 | 说明 |
|------|------|
| `collapsedToolResultLines` | 折叠态最多显示行数；`0`=完全隐藏；匹配优先级：精确名 > 通配符 > `*` |
| `collapsedToolResultMaxChars` | 仅已折叠时生效，不会单独触发折叠 |

默认值：read=10, grep=15, bash=20, write=10，其他工具 `*`=20。

#### `notify`

控制 `scripts/notify.sh` 桌面通知（仅 UI session）。

```json
{
  "notify": { "permissionAsked": true, "agentEnd": true, "suppressCompletedAfterRejectionMs": 0 }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `permissionAsked` | false | 权限确认前通知；同一回合多次确认只通知一次 |
| `agentEnd` | false | session 正常结束发 completed，异常停止发 error；yolo 模式下仍会发送停止通知 |
| `suppressCompletedAfterRejectionMs` | 5000 | 用户拒绝权限后抑制 completed 通知的窗口；`0` 关闭抑制 |

#### `contextCompression`

压缩旧的工具输出以减少上下文噪音，默认关闭。

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "tools": ["bash", "grep", "find", "read", "write", "edit"],
    "retainedUserMessageRounds": 2,
    "retainedAssistantTurns": 4,
    "enabledProviders": ["openai"]
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `anchorHygiene` | false | 后续 write/edit 成功后，折叠同路径旧的 read/edit 结果；write ack 不参与折叠 |
| `tools` | — | 按 `toolCall.name` 精确匹配，需压缩的工具名列表 |
| `retainedUserMessageRounds` | 2 | 保留最近的 N 轮 user 消息 |
| `retainedAssistantTurns` | 4 | 保留最近的 N 次 assistant turn |
| `enabledProviders` | 不限制 | 仅对这些 provider id 生效（大小写不敏感）；`[]`=全部不生效 |
| `disabledProviders` | — | 即使命中 enabledProviders 也跳过压缩（大小写不敏感）；不允许空数组 |

生效顺序：`enabledProviders` 过滤 → `disabledProviders` 过滤 → 都通过后启用。仅压缩成功的 `toolResult.content`，失败的永不被压缩。read 到已注入 skill 路径的文件不参与 age compression（除非被后续 anchorHygiene 触发）。

#### `subagent`

控制 `task` 委派的深度和并发限制。

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
| `maxDepth` | 2 | 根 depth=1；depth ≥ maxDepth 时不注入 task |
| `maxConcurrency` | 10 | 单父 session 直接子 agent 并发上限；超限直接报错 |
| `maxTotalConcurrency` | 关闭 | 整棵 delegation tree 并发上限；超限即使父 session 未达 maxConcurrency 也报错 |
| `idleTimeoutMs` | 关闭 | 无 assistant/session 进展时的空闲超时（tool 执行中不触发）；计时 >0 时生效 |
| `maxTurns` | 50 | 达到此 assistant turn 数后一次性注入软收尾提示；不会强制终止子 agent |

root UI 的 editor-adjacent widget 展示运行中 subagent 的 parent/child 树、turn/tool call 计数和最近活动；历史 `task` tool block 保持稳定。`/subagent` 打开运行中 session 选择器，`/subagent <session-id-or-unique-prefix>` 可直接只读查看运行中或已持久化结束的 session transcript。

parent turn 在委派开始前已取消时不会创建或恢复 child session。初始化过程中发生的取消会在 startup 返回后立即传播；不使用只提前返回但无法停止后台初始化的 promise race。

#### `mcp`

本地和远程 MCP server。

```json
{
  "mcp": {
    "startupTimeoutMs": 60000,
    "callTimeoutMs": 60000,
    "servers": {
      "local-example": {
        "type": "local",
        "command": ["my-mcp", "serve"],
        "cwd": "~/work/mm",
        "env": { "API_KEY": "${API_KEY}" },
        "toolPrefix": "",
        "startupTimeoutMs": 60000,
        "callTimeoutMs": 60000
      },
      "remote-example": {
        "type": "remote",
        "transport": "streamable-http",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "${DOCS_TOKEN}" },
        "toolPrefix": "docs"
      }
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| 本地 `command` | `command[0]` 需 PATH 命令或绝对路径（支持 `~/`/`$HOME/`/`${HOME}/`） |
| 本地 `cwd` | 绝对路径（支持 HOME shortcut） |
| 远程 `transport` | `websocket` / `sse` / `streamable-http`；websocket 不支持自定义 headers |
| `env` / `headers` | 仅支持 `$VAR` 或 `${VAR}` 整值引用，不支持字符串内插；引用不存在则连接失败 |
| `toolPrefix` | 默认等于 server key；`""`=保留原始 tool 名 |
| `enabled` | `false` 禁用该 server |
| `startupTimeoutMs` | server 启动超时，覆盖 `mcp.startupTimeoutMs` 全局默认；默认 `60000` |
| `callTimeoutMs` | 单次工具调用超时，覆盖 `mcp.callTimeoutMs` 全局默认；默认 `60000`。超时由 MCP SDK 取消对应请求，不会因单次慢调用重启 server |
| `mcp.startupTimeoutMs` / `mcp.callTimeoutMs` | 全局默认，可在未声明 `servers` 时单独配置 |

同一 Pi 进程内，每个 MCP server 配置只建立一个共享连接/本地进程，root 与所有 subagent 共用。首次 `session_start` 会并行等待所有 enabled server 完成首次连接或达到 `startupTimeoutMs`，因此首个 prompt 只会在 MCP readiness 确定后开始；后续 subagent 直接复用同一 readiness 和工具列表。`pi-base` 继续在后台维护重连 + heartbeat，状态显示在 footer。

---

## 命令

| 命令 | 说明 |
|------|------|
| `/agent <name>` | 切换 agent |
| `/agent` | 有 UI 弹选择器 |
| `/yolo` | 切换当前进程权限绕过状态，不回写配置 |
| `/mcp-status` | 输出 MCP server/工具状态树，含冲突和 stale 工具 |
| `/resume-all` | 跨项目恢复 session，需交互式 UI |
| `/reload` | (Pi 内置) 重载配置、扩展资源和 agent 定义 |

## 运行时行为

### 输出截断

所有工具结果经统一截断层：

| 限制 | 值 |
|------|-----|
| 最大行数 | 2000 |
| 最大字节数 | 50 KB |
| 完整输出 | 保存至 `<tmp>/pi-base-truncation/`（非 Windows 收紧至 `0700`） |
| 旧文件清理 | 保留约 7 天 |

上游已自行截断且暴露 `Full output` 路径的工具（如 Pi core bash）保留上游路径，不重复落盘。

`details.truncation` 字段：

| 字段 | 含义 |
|------|------|
| `truncated` | 是否发生截断 |
| `alreadyTruncated` | 上游是否已截断 |
| `outputPath` | 完整输出路径 |
| `totalLines` | 原始总行数 |
| `totalBytes` | 原始总字节数 |

### 错误标记修复

`pi-base` 工具在错误结果的 `details` 写入内部标记；全局 `tool_result` hook 识别标记 + 文本启发式兜底，确保内置/LSP/MCP 工具稳定补齐 `isError: true`。

### 状态栏（UI session）

| 状态项 | 示例 |
|--------|------|
| 权限模式 | `YOLO`（仅 yolo 时显示） |
| MCP 连接 | `MCP: 2/3 servers` |
| 当前 agent | `agent:planner`（默认显示 `agent:default`） |

---

## 开发

```bash
npm run typecheck   # TypeScript 类型检查
npm test            # 运行测试
npm run test:coverage  # 测试 + 覆盖率
```

> 从 shell 用 `pi -p` 调试时，注意对 prompt 做引用，避免 shell 展开 `$(...)`、反引号、`$VAR` 或 glob。
