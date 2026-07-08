# pi-base

`pi-base` 是一个给 Pi 用的基础扩展包，不是独立应用，也不是新的 agent runtime。它的目标很简单：给 Pi 提供一套稳定、可配置、适合本地代码仓开发的 baseline，包括文件工具、`bash`、`LSP`、`MCP`、权限控制、通知，以及基于 Markdown 的 agent 切换。

## 目录

- [它是什么](#它是什么)
- [安装与启用](#安装与启用)
- [快速开始](#快速开始)
- [Agent](#agent)
- [工具与工作流](#工具与工作流)
- [配置总览](#配置总览)
- [配置参考](#配置参考)
- [命令](#命令)
- [运行时行为](#运行时行为)
- [开发](#开发)

## 它是什么

`pi-base` 解决的是“把 Pi 调成一个顺手的本地 coding baseline”这件事。当前实现覆盖这些能力：

- 本地工具：`read`、`grep`、`find`、`edit`、`write`、`bash`
- 语言能力：`lsp_diagnostics`、`lsp_goto_definition`、`lsp_workspace_symbols`、`lsp_java_decompile`
- 外部工具：通过 `mcp.servers` 接入本地或远程 MCP server
- 运行时控制：`permission`、`notify`、`yolo`、`contextCompression`
- agent 系统：`~/.pi/agent/agents/**/*.md` 中定义 agent，通过 `/agent` 动态切换 prompt、model、thinking、tools、skills

启动时，`pi-base` 会确保基础工具集可用：

- `read`
- `grep`
- `find`
- `bash`
- `edit`
- `write`
- `lsp_diagnostics`
- `lsp_goto_definition`
- `lsp_workspace_symbols`
- `lsp_java_decompile`

如果当前 active tools 里还残留已退役的 `task`，启动时也会自动移除。

## 安装与启用

长期使用时，建议把 `pi-base` 作为 Pi package 安装，让它跟随 Pi 一起自动加载并支持 `/reload`。开发或临时验证时，也可以直接从源码入口加载：

```bash
pi -e /path/to/pi-base/index.ts
```

`pi-base` 自己不额外发明配置入口，仍然使用 Pi 的扩展加载机制。

## 快速开始

### 1. 准备 `pi-base.json`

`pi-base` 只认这两个配置文件位置：

- 全局：`~/.pi/agent/pi-base.json`
- 项目：最近祖先目录中的 `<repo>/.pi/pi-base.json`

最小可用配置是：

```json
{}
```

如果只想做隔离测试，也可以用环境变量覆盖全局配置路径：

```bash
export PI_BASE_GLOBAL_SETTINGS_PATH=/tmp/pi-base.json
```

### 2. 可选：准备默认 agent

默认 agent 复用 Pi 现有的默认资源：

- `~/.pi/agent/SYSTEM.md`
- `~/.pi/agent/settings.json`
- `<workspace-cwd>/.pi/settings.json`

这里列的是 Pi 默认 session 会用到的三个字段；`pi-base` 会沿用 Pi 已提供的默认值，不会自己重新解析 `settings.json` 的其它内容：

```json
{
  "defaultProvider": "provider",
  "defaultModel": "model-id",
  "defaultThinkingLevel": "medium"
}
```

Pi 自身会按“当前 workspace cwd 下的 `.pi/settings.json` 优先于全局 `~/.pi/agent/settings.json`”的顺序提供默认值，`pi-base` 直接沿用这份 session 默认状态。

如果希望 fresh session 启动时自动进入某个命名 agent，可以在 `pi-base.json` 里加：

```json
{
  "defaultAgent": "planner"
}
```

启动选择顺序是：`session 已持久化的 agent > --agent <name> > pi-base.json.defaultAgent > default`。
如果 `defaultAgent` 未配置或指向不存在的 agent，会回退到 `default`（即 `SYSTEM.md` / 内置默认定义）。

### 3. 启动后重载

修改 `pi-base.json`、`SYSTEM.md`、`settings.json` 或 agent Markdown 后，在 Pi 中执行：

```text
/reload
```

`pi-base` 会重新读取配置、重新扫描 agent 文件，并重新建立运行时状态。

### 4. 日常使用

典型工作流就是：

1. 用 `read`、`grep`、`find`、`lsp_*` 看代码和定位问题。
2. 用 `edit` 做小范围修改，用 `write` 新建或整体覆盖文件。
3. 用 `bash` 跑测试、构建、git 或外部 CLI。
4. 用 `/agent` 在不同工作模式之间切换。
5. 需要额外工具时，通过 `mcp.servers` 接入 MCP。

## Agent

### 定义位置

命名 agent 放在：

```text
~/.pi/agent/agents/**/*.md
```

`pi-base` 会递归扫描这个目录。默认 agent 名固定为 `default`；当 agent 正文为空时，`pi-base` 会回退到 Pi 加载的 `customPrompt`（通常来自 `~/.pi/agent/SYSTEM.md`）。

### Frontmatter 字段

每个 agent Markdown 支持这些 frontmatter 字段：

- `name`
- `description`
- `model`，格式必须是 `provider/modelId`；仅作为显式选中该 agent 时的建议值
- `thinkingLevel`；仅作为显式选中该 agent 时的建议值
- `tools`
- `skills`
- `subagents`

示例：

```md
---
name: planner
description: Planning-focused agent
model: provider/model-id
thinkingLevel: high
tools:
  - read
  - grep
skills:
  - spec
---

You are a planning-focused agent. Break work into clear steps before editing.
```

### 行为规则

- `default` 是保留名，agent 文件不能使用这个名字。
- `tools` 未配置：所有工具可用。
- `tools: []`：显式禁用所有工具。
- `tools` 配置为非空数组：作为 allowlist，`pi-base` 会调用 `pi.setActiveTools()`，未列出的工具对 agent 不可见。
- `skills` 未配置：在 `read` 工具可用时，所有可见 skills 都会注入 prompt。
- `skills: []`：显式禁用所有 skills 注入。
- `skills` 配置为非空数组：`pi-base` 先按 allowlist 过滤 skills，再统一重建 system prompt。
- skills 过滤只影响 prompt 注入，不会额外隐藏用户侧显式输入的 `/skill:name`。
- skills 注入本身仍然遵循 Pi 默认行为：只有 `read` 工具可用时才会注入 `<available_skills>`，且 `disable-model-invocation` 的 skill 不会暴露给模型。
- `subagents` 未配置或为空：该 agent 不会获得 `task` 委派工具。
- `subagents` 配置为非空数组：只有其中真实存在的 agent 会保留；不存在的 agent 会在启动或 `/reload` 时输出 warning，并从 allowlist 中剔除。
- 当 `subagents` 过滤后的结果非空，且当前 session depth 还没有达到 `subagent.maxDepth` 时，`pi-base` 会为该 agent 注入 `task` 工具，并在 system prompt 中列出可委派的 subagent 名称和描述。
- 所有 agent 都由 `pi-base` 统一重建 system prompt：agent Markdown 正文非空时覆盖 Pi 加载的 `customPrompt`；正文为空时回退到 Pi 加载的 `customPrompt`（通常是 `SYSTEM.md`）。
- 若当前 agent 与 Pi 都没有可用的 `customPrompt`，`pi-base` 会保留 Pi 预构建的 system prompt 作为兜底。
- agent 持续控制的是 prompt / tools / skills / subagents；session 自己的 `model` 和 `thinkingLevel` 在 resume / reload 时不会被 agent 覆盖。
- `model` 和 `thinkingLevel` 只在显式选中 agent 时做 best-effort 应用：`/agent <name>`、fresh session 命中 `--agent`、或 fresh session 命中 `defaultAgent`。
- `/agent default` 不会强制把 session 的 `model` / `thinkingLevel` 重置回 `settings.json` 默认值；若要改回默认模型，请显式切 model。
- 如果 agent 定义的 `model` 或 `thinkingLevel` 无法应用，`pi-base` 会给出 warning，但不会阻塞 agent 本身切换。
- 最近一次显式 `/agent xxx` 切换会写入 session entry；后续 `session_start` 会自动恢复。
- fresh session 的启动选择顺序是：`session 已持久化的 agent > --agent <name> > pi-base.json.defaultAgent > default`。
- `--agent` 或 `defaultAgent` 指向不存在的 agent 时，会在 startup UI 上提示 warning，并回退到 `default`。
- 当 fresh session 没有命中上述启动 agent 时，启动阶段不会强制重置当前 model / thinking / active tools，只更新默认状态显示。
- 启动或 `/reload` 时，格式错误、重名或非法 agent 会被忽略，并输出 warning。

### 切换方式

- `/agent planner`
- `/agent default`
- `/agent`

`/agent` 无参数时，如果当前有 UI，会弹选择器；无 UI 时需要显式带名字。

## 工具与工作流

### `read`

`read` 支持：

- 文本文件
- 目录
- 图片：`.jpg`、`.jpeg`、`.png`、`.gif`、`.webp`

文本读取行为：

- `offset` 默认 `1`
- `limit` 默认 `200`，最大 `2000`
- 文本读取返回统一的 agent 视图：头部包含 `path`、`ends_with_newline`，支持 LSP 的文件类型还会额外给出 `lsp`；正文使用右对齐的 `数字|内容` 编号格式
- 支持 UTF-8、UTF BOM、UTF-16 启发式和常见 legacy 编码探测；模型看到的是 LF 规范化后的简单文本视图
- 单行显示超过 `2000` 字符时会在显示层截断，并标记该行被截断
- 分页信息通过结果末尾的 `[Showing lines ...]` notice 给出
- `ends_with_newline: yes` 表示文件末尾存在换行，但 `read` 不会专门额外生成一个编号空行去表示它

其它行为：

- 目录读取会列出排序后的成员
- 二进制文件会直接报错
- 当前模型不支持图片输入时，不会内联图片，而是返回 `image-understanding` skill 的 `skillDoc` 路径提示
- 当前模型支持图片输入时，会把图片作为附件返回，并补一段文本说明

### `grep`

- `pattern` 必填
- `path` 必填
- `workdir` 默认当前 agent cwd
- `timeout_seconds` 默认 `15`
- `limit` 默认 `100`
- 支持 `include`、`ignore_case`、`literal`、`multiline`
- 搜索单个文件时会先探测二进制内容，二进制文件直接报错
- 输出是候选位置，不是编辑锚点；编辑前先 `read`
- 行过长时会截断到 `500` 字符，并在结果末尾给出提示

### `find`

- `pattern` 必填
- `path` 必填，没有隐式默认搜索根；如果就是要搜当前目录，请显式写 `"."`
- `workdir` 默认当前 agent cwd
- `limit` 默认 `1000`
- `timeout_seconds` 可选，默认不设超时
- 底层仍使用 Pi 内置的 `find` / `fd` 能力，但 `pi-base` 强制要求显式 `path`

### `edit`

- 适合小范围、精确文本替换
- 参数是 `path`、`old_string`、`new_string`，可选 `replace_all` 和 `workdir`
- `old_string` 必须与文件当前内容中的文本精确匹配；匹配 0 次或多次时会失败，除非显式 `replace_all: true`
- 模型应从最近的 `read` 输出复制真实文件内容，不要包含前面的 `数字|` 编号列
- 可以用空字符串 `new_string` 表达删除；`old_string` 不允许为空，如需头插或大范围重写，请改用 `write` 或提供更明确的编辑锚点
- 编辑时会基于统一 LF 视图匹配，再按文件真实 BOM、编码、换行风格和尾行换行映射回磁盘
- 修改成功后返回替换次数和同样使用 `数字|内容` 风格的编号 diff 预览

### `write`

- 适合新文件或整文件覆盖
- 会自动创建父目录
- 对已有文件会尽量沿用原编码、BOM 和换行风格；新文件默认 UTF-8
- 成功后返回创建或覆盖成功的简短结果

### `bash`

- `command` 必填
- `workdir` 默认当前 agent cwd
- `timeout_seconds` 默认 `120`
- 非 Windows 平台会优先使用宿主机 `$SHELL` 指向的 `bash` 或 `zsh`
- 如果是宿主 `bash` / `zsh`，会在执行前加载常见启动文件，再回到原始 cwd
- 优先通过 `workdir` 切换目录，不要在 `command` 中写 `cd ... &&`

### `lsp_*`

`pi-base` 不内置任何 LSP server 表，全部由 `lsp.servers` 显式声明。

支持的工具：

- `lsp_diagnostics`
- `lsp_goto_definition`
- `lsp_workspace_symbols`
- `lsp_java_decompile`

参数要点：

- `lsp_diagnostics` 支持 `severity`，默认 `all`
- `lsp_goto_definition` 需要 `line`，`character` 默认 `0`
- `lsp_workspace_symbols` 需要 `query`，`limit` 默认 `50`
- `lsp_java_decompile` 需要任意一个目标 workspace 里的本地 `.java` 文件作为 `path`，`target` 可以是 `jdt://` URI、workspace symbol 输出中的目标，或 `file://` / `.class` 路径

行为要点：

- 文件后缀未命中任何 `lsp.servers` 时，直接返回 `No LSP server configured for ...`
- `lsp_goto_definition` 会先检查 server 是否声明了 `textDocument/definition`
- `lsp_workspace_symbols` 会先检查 server 是否声明了 `workspace/symbol`
- `lsp_java_decompile` 只在支持 `java/classFileContents` 的 server 上可用，通常就是 `jdtls`
- `lsp_diagnostics` 不做同样的能力前置检查，因为有些 server 的 diagnostics 能力声明并不可靠

### MCP 工具

`mcp.servers` 中已连接的 server 会自动注册工具：

- 默认工具名格式是 `<serverKey>_<toolName>`
- `toolPrefix: ""` 时保留远端原始 tool 名
- 当当前 agent 没有 `tools` allowlist 时，新出现的 MCP 工具会自动加入 active tools
- 当当前 agent 显式配置了 `tools` allowlist 时，只有 allowlist 中包含的 MCP alias 才会加入 active tools；不会因为 heartbeat / reconnect 把额外的 MCP 工具重新塞回当前 agent
- 同名冲突时，该工具不会注册，并在 `/mcp-status` 中显示冲突原因

## 配置总览

`pi-base.json` 顶层支持这些字段：

| 字段 | 作用 |
| --- | --- |
| `permission` | 工具执行策略，支持 `allow` / `ask` / `deny` |
| `lsp` | 定义 LSP server 列表 |
| `render` | 控制工具结果折叠预览 |
| `notify` | 控制权限请求和 agent 完成通知 |
| `yolo` | 设置默认 YOLO 模式 |
| `mcp` | 定义本地或远程 MCP server |
| `contextCompression` | 压缩旧工具输出，减少上下文噪音 |
| `subagent` | 控制 `task` 委派深度、直接子并发上限与整树总并发上限 |
| `defaultAgent` | fresh session 启动时默认进入的命名 agent |

一个常见起点：

```json
{
  "permission": {
    "edit": "ask",
    "write": "ask",
    "bash": {
      "*": "ask",
      "git *": "allow"
    }
  },
  "lsp": {
    "servers": {
      "ts": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx"]
      }
    }
  },
  "notify": {
    "permissionAsked": true,
    "agentEnd": true
  }
}
```

### 配置查找和缓存

- 全局配置默认路径：`~/.pi/agent/pi-base.json`
- 项目配置路径：从当前 cwd 向上查找最近的 `.pi/pi-base.json`
- 运行时会按 workspace 缓存配置
- 修改配置后要执行 `/reload`

### 配置合并语义

不是所有字段都做同一种 merge，代码里的规则如下：

- `lsp.servers`
  项目配置一旦出现 `servers`，会整体替换全局 `servers` map，不做逐个 server 深合并。
- `permission`
  全局规则和项目规则按 tool 名追加合并，后出现的规则继续参与匹配；最终仍然是“最后一个匹配规则生效”。
- `render`
  全局和项目配置会合并；如果全局是单个数字，会被当作 `"*"` 默认值，再叠加项目里的细粒度规则。
- `notify`
  浅覆盖合并，项目配置只覆盖自己声明的字段。
- `yolo`
  项目值直接覆盖全局值。
- `mcp.servers`
  server map 按 key 合并；同 key 的项目配置覆盖同 key 的全局配置。
- `contextCompression`
  各标量字段逐个覆盖；`tools` 数组是替换，不是追加。
- `subagent`
  `maxDepth` 和 `maxConcurrency` 都按字段浅覆盖；未配置的一侧继续继承全局值。
- `defaultAgent`
  项目值直接覆盖全局值。

## 配置参考

### `defaultAgent`

`defaultAgent` 用来指定 fresh session 在没有已持久化 agent、也没有传 `--agent` 时，自动进入哪个命名 agent。

示例：

```json
{
  "defaultAgent": "planner"
}
```

行为规则：

- 建议填写已存在的 agent 名（也可以显式写 `default`）
- 选择顺序是：`session 已持久化的 agent > --agent <name> > defaultAgent > default`
- `defaultAgent` 指向不存在的 agent 时，会在启动时给出 warning，并回退到 `default`
- 命中的 `defaultAgent` 会像 `--agent` 一样写入 session entry，后续 turn / resume 会继续沿用
- 若该 agent 定义了 `model` / `thinkingLevel`，只会在命中 `defaultAgent` 的 fresh session 启动时 best-effort 应用；后续 resume / reload 仍以 session 自己的值为准

### `render`

`render.collapsedToolResultLines`：

- 可以是单个非负整数
- 也可以是按工具名或通配符配置的对象
- 只影响工具结果折叠预览，不影响工具调用预览
- 对使用共享结果渲染器的工具（如 `read`、`find`、`grep`、`edit`、`write`、`lsp_*` 和大多数 `mcp_*`）：
  - `0` 表示折叠态完全隐藏结果区域
  - `N > 0` 表示折叠态最多占 `N` 行；当结果正文至少有 `N` 行时，会显示前 `N-1` 行，再用最后 1 行显示展开提示
  - 当结果正文为空，或结果正文行数少于 `N` 时，折叠态不显示结果区域
- `render.collapsedToolResultMaxChars` 只在折叠预览已经显示时生效，不会单独触发折叠预览
- `bash` 仍使用专用结果渲染器：折叠态预览尾部输出，并继续显示 timing / truncation 等附加信息
- 当未显式配置时，当前默认值是：`read=10`、`grep=15`、`find=20`、`bash=20`、`write=10`
- 其它工具未配置时沿用各自 renderer 当前默认值
- 匹配优先级：精确工具名 > 更具体的通配符 > `*`

示例：

```json
{
  "render": {
    "collapsedToolResultLines": {
      "*": 20,
      "read": 10,
      "grep": 15,
      "lsp_*": 5,
      "mcp_*": 8,
      "edit": 0
    }
  }
}
```

`render.collapsedToolResultMaxChars`：

- 可以是单个非负整数
- 也可以是按工具名或通配符配置的对象
- 只影响折叠态的字符数，不影响展开态
- 匹配优先级和 `collapsedToolResultLines` 一样

示例：

```json
{
  "render": {
    "collapsedToolResultMaxChars": {
      "*": 10000,
      "bash": 4000,
      "*_search": 2000,
      "web_search": 1200
    }
  }
}
```

### `contextCompression`

`contextCompression` 是唯一的上下文裁剪配置，默认关闭。它只会投影当前消息列表，不会修改工具调用参数，也不会删除 assistant 的 toolCall block。

支持字段：

- `anchorHygiene`
- `retainedUserMessageRounds`
- `retainedAssistantTurns`
- `tools`
- `enabledProviders`（仅对这些 provider id 生效；未配置时表示不限制）
- `disabledProviders`（按 provider id 跳过压缩；即使命中了 `enabledProviders`，只要这里匹配也会禁用）

行为规则：

- `anchorHygiene` 默认 `false`
- `tools` 是需要做“旧输出压缩”的 tool name 列表，按 `toolCall.name` 精确匹配
- 只会压缩成功的 `toolResult.content`
- 失败的工具结果永远不会被压缩
- 如果配置了 `tools` 但没写保留策略，默认是 `retainedUserMessageRounds: 2` 和 `retainedAssistantTurns: 4`
- `read` 到当前 prompt 中已注入 skill 路径下的文件时，不参与普通的 age compression；只有在同文件后来被改动且 `anchorHygiene` 生效时才会被折叠
- 不会额外写 session marker，也不会显示长期 UI 标记
- `enabledProviders` 未配置时，provider 不受限制
- `enabledProviders` 配置为数组时，只有命中的 provider 才会做 context compression；未命中直接跳过
- `enabledProviders: []` 表示没有任何 provider 会命中，因此等价于“全部不生效”
- 在通过 `enabledProviders` 检查后，若 `ctx.model.provider` 又命中 `disabledProviders`（都不区分大小写），**本次 LLM 调用仍然不做任何 context 投影**（消息原样发送）
- 也就是 provider 生效顺序为：先看 `enabledProviders`，再看 `disabledProviders`，两者都通过才启用压缩
- `anchorHygiene` 会折叠已经被后续修改影响的旧 `read`/`edit` 成功结果，避免历史工具输出误导当前编辑判断；`write` 的成功 ack 视为时间线锚点，**不参与** anchorHygiene 折叠（它仍会让同路径的旧 `read`/`edit` 失效）


示例：

```json
{
  "contextCompression": {
    "anchorHygiene": true,
    "retainedUserMessageRounds": 2,
    "retainedAssistantTurns": 4,
    "tools": ["bash", "grep", "find", "read", "write", "edit"],
    "enabledProviders": ["openai", "xai"],
    "disabledProviders": ["xai"]
  }
}
```

### `notify`

`notify` 控制 `pi-base` 自己发出的桌面通知，只在有 UI 时生效。

支持字段：

- `permissionAsked`
- `agentEnd`
- `suppressCompletedAfterRejectionMs`

行为规则：

- 省略 `notify` 时默认不通知
- `permissionAsked: true` 时，在权限确认前发通知
- 同一模型回合（一条 assistant 消息及其整批 tool call）内的多次权限确认只通知一次，下一回合（`turn_start`）重置后再次通知
- `agentEnd: true` 时，在 `agent_end` 后发停止通知：正常结束发 completed，最终异常停止发 error
- 当前 runtime 处于 yolo 模式时，仍然会在 agent 真正停下后发送停止通知；yolo 只是因为不会弹权限确认，所以自然不会产生 permission 通知
- `suppressCompletedAfterRejectionMs` 默认 `5000`
- `suppressCompletedAfterRejectionMs: 0` 表示关闭抑制窗口
- 通知脚本固定使用包内的 `scripts/notify.sh`
- 没有单独的自定义命令路径配置

示例：

```json
{
  "notify": {
    "permissionAsked": true,
    "agentEnd": true,
    "suppressCompletedAfterRejectionMs": 0
  }
}
```

### `permission`

`permission` 使用 `allow` / `ask` / `deny` 三态模型。

支持三种写法：

- 整个 `permission` 直接写成一个字符串，作用于所有工具
- 直接给某个 tool 一个字符串
- 给某个 tool 一个 pattern -> action 的对象

示例：

```json
{
  "permission": {
    "*": "allow",
    "edit": "ask",
    "write": "ask",
    "bash": {
      "*": "ask",
      "git *": "allow",
      "npm test": "deny"
    }
  }
}
```

行为规则：

- `ask` 会在交互模式下弹出确认框
- 确认框只提供 `Yes` / `No`
- 提示里会显示 `Tool`、`Workdir` 和单行压缩后的 `Arguments`
- 根 session 没有 UI 时，`ask` 直接拦截调用；但真正的 headless subagent session 如果其 root session 有 UI，会把确认请求转发给 root UI
- 没有会话内的“永久允许这类调用”快捷方式，后续自动放行只能靠配置规则
- 对路径类工具，会匹配：
  - 原始传入路径
  - 相对 `workdir` 的路径
  - 相对项目根的路径
  - 绝对路径
- 对 `bash`，会对顶层静态 surface command 段做匹配，能识别 `&&`、`||`、`|`、`|&`、`;` 和换行
- `bash` 规则不会展开变量，不会深入解析 `bash -c`、命令替换、`eval`、`source`、函数或 alias
- 如果 `bash` 命令表面结构无法安全分析，则静态规则只要没有命中 `deny`，结果会退回到 `ask`

### `yolo`

`yolo` 是一个布尔值：

```json
{
  "yolo": true
}
```

行为规则：

- 默认 `false`
- 只在 workspace 首次载入配置时为运行时状态设初值
- `/yolo` 只切换当前 Pi 进程里的运行时状态
- `/yolo` 不会回写 `pi-base.json`

### `mcp`

`mcp.servers` 支持本地和远程两类 server。

本地 server：

```json
{
  "mcp": {
    "servers": {
      "mm": {
        "type": "local",
        "command": ["my-mcp", "serve"],
        "cwd": "~/work/mm",
        "env": {
          "API_KEY": "${API_KEY}"
        },
        "toolPrefix": "",
        "startupTimeoutMs": 60000
      }
    }
  }
}
```

远程 server：

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
        },
        "toolPrefix": "docs"
      }
    }
  }
}
```

支持字段：

- 本地：`command`、`env`、`cwd`、`enabled`、`toolPrefix`、`startupTimeoutMs`
- 远程：`transport`、`url`、`headers`、`enabled`、`toolPrefix`、`startupTimeoutMs`

行为规则：

- `enabled: false` 时该 server 处于禁用状态
- `toolPrefix` 默认等于 server key
- `toolPrefix: ""` 时暴露原始远端 tool 名
- 本地 `command[0]` 可以是 PATH 中的命令，或绝对路径；如果写成路径形式，也支持 `~/...`、`$HOME/...`、`${HOME}/...`
- 本地 `cwd` 必须是绝对路径，但支持 `~/...`、`$HOME/...`、`${HOME}/...`
- `env` 和 `headers` 只支持“整个值恰好是 `$VAR` 或 `${VAR}`”的环境变量引用，不支持字符串内插值
- 引用的环境变量不存在时，连接会失败
- 远程 transport 只支持：`websocket`、`sse`、`streamable-http`
- 由于底层 SDK 限制，`websocket` transport 不支持自定义 headers
- `startupTimeoutMs` 默认 `60000`
- MCP 启动是异步的，不阻塞 session 启动
- `pi-base` 会维护重连和 heartbeat，并把状态显示到 footer

### `subagent`

`subagent` 控制 `task` 委派工具的深度、并发，以及防卡死守护策略。

示例：

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

支持字段：

- `maxDepth`
- `maxConcurrency`
- `maxTotalConcurrency`
- `idleTimeoutMs`
- `maxTurns`

行为规则：

- `maxDepth` 默认 `2`
- 根 session depth 记为 `1`；只有当 `当前 depth < maxDepth` 时，带有效 `subagents` allowlist 的 agent 才会注入 `task`
- `maxConcurrency` 默认 `10`
- `maxConcurrency` 只限制同一个父 session 当前正在运行的直接子 subagent 数量；超过上限时，新的 `task` 调用会直接报错
- `maxTotalConcurrency` 默认关闭；配置后，它限制同一个 root session 下面整棵 delegation tree 当前同时运行或启动中的 subagent 总数；超过上限时，即使当前父 session 自己还没达到 `maxConcurrency`，新的 `task` 也会直接报错
- `idleTimeoutMs` 默认关闭；配置后，它衡量的是“没有 assistant / session 侧进展时的空闲时间”。一旦 child 已进入 tool 执行阶段，tool 本体运行过程中的静默不会触发这个 watchdog；只有 tool 结束后重新等待下一次 assistant / 模型侧进展时才会重新计时
- `maxTurns` 默认 `50`；当 child 已完成 `N` 次 assistant turn 且仍在继续发起工具循环时，`pi-base` 会像 opencode 的 `maxSteps` 一样，在后续每一轮继续注入一条“立即收尾并返回最终报告”的 follow-up 提示，直到 child 自己结束
- `task` 运行时会再次校验 `subagent_type`：
  - agent 不存在时，报错并列出当前 agent 可用的 subagent 名称
  - agent 存在但不在当前 agent 的 `subagents` allowlist 中时，报错 `not allowed`
- `task` 执行中会在 tool row 中输出简洁进展日志（如子 agent 启动、工具开始/结束、assistant 文本摘要）；完成后中间进展会被最终结果替换。
- root session UI 会展示当前运行中 subagent 的 parent/child 树；同级 subagent 按启动时间排序，嵌套 subagent 按真实 `parentSessionId` 缩进。

### `lsp`

`lsp.servers` 是完全用户定义的映射，`pi-base` 不内置任何 server 表。

示例：

```json
{
  "lsp": {
    "servers": {
      "jdtls": {
        "command": ["$HOME/.local/share/nvim/mason/bin/jdtls"],
        "extensions": [".java"],
        "rootMarkers": ["pom.xml", "build.gradle", "settings.gradle"],
        "firstMatchMarkers": [".git"],
        "workspaceData": {
          "mode": "process"
        }
      },
      "typescript-language-server": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
        "firstMatchMarkers": [".git", "package.json", "tsconfig.json", "jsconfig.json"]
      },
      "gopls": {
        "command": ["gopls"],
        "extensions": [".go"],
        "firstMatchMarkers": [".git", "go.mod", "go.work"],
        "requestTimeoutMs": 60000
      }
    }
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `command` | 是 | 可执行文件和参数。`command[0]` 必须是 PATH 中的命令，或绝对路径。支持 `~/...`、`$HOME/...`、`${HOME}/...`。 |
| `extensions` | 是 | 此 server 负责的文件后缀列表。 |
| `rootMarkers` | 否 | 多模块项目根标记，采用“最顶层匹配优先”。 |
| `firstMatchMarkers` | 否 | 备选根标记，采用“第一次匹配优先”。 |
| `requestTimeoutMs` | 否 | 每个请求的超时，默认 `60000`。 |
| `workspaceData` | 否 | 仅影响 `jdtls` 自动注入的 `-data` 目录；显式写在 `command` 里的 `-data` 优先。 |

行为规则：

- 相对路径形式的 `command[0]` 会被拒绝
- 只支持 `HOME` 相关路径展开，不支持像 `$JAVA_HOME/...` 这样的任意环境变量路径展开
- 要“禁用”一个 server，直接从 map 中去掉；没有 `disabledServers`
- `rootMarkers` 和 `firstMatchMarkers` 都存在时，优先使用 `rootMarkers` 的最顶层结果，否则退回 `firstMatchMarkers`
- 缺失可执行文件时，会返回带具体 `pi-base.json` 片段的错误提示
- `pi-base` 不额外提供 `jvmArgs` 字段；所有 server 特定参数都直接写在 `command` 里
- `jdtls` 默认会自动追加 `-data ~/.cache/jdtls-workspace/<workspace-md5>`，避免不同项目共享同一个 workspace data
- 多个 Pi 进程并发打开同一个 Java workspace 时，建议配置 `workspaceData: { "mode": "process" }`，生成 `<workspace-md5>-<pid>`，避免 jdtls 文件锁冲突
- `workspaceData.mode` 支持 `stable`、`process`、`disabled`；`workspaceData.baseDir` 可改写生成目录的父目录，必须是绝对路径或 HOME shortcut

## 命令

`pi-base` 自己注册这些命令：

- `/agent`
  - `/agent <name>` 切换到指定 agent
  - `/agent default` 切回默认 agent
  - `/agent` 在有 UI 时弹选择器
- `/yolo`
  - 切换当前进程的权限绕过状态
  - 不接受参数
- `/mcp-status`
  - 输出当前 MCP server 摘要和工具树
  - 显示连接状态、重连状态、冲突和 stale 工具
- `/resume-all`
  - 跨项目恢复 session
  - 需要交互式 UI
  - TUI 模式下直接进入 all-project 视图

此外，Pi 自带的 `/reload` 对 `pi-base` 很关键，因为它会重载配置、扩展资源和 agent 定义。

## 运行时行为

### 输出截断

所有工具结果都会经过统一截断层：

- 最大行数：`2000`
- 最大字节数：`50KB`
- 完整输出默认保存到系统临时目录下的 `pi-base-truncation/`（例如 Linux / macOS 常见为 `/tmp/pi-base-truncation/`）
- 上游已经自行截断并暴露 `Full output` 路径的工具（例如 Pi core 的 `bash`）会保留上游路径，不再额外搬运到 `pi-base` 自己的目录
- 目录会按平台做 best-effort 创建；非 Windows 平台会尝试收紧到 `0700`
- 旧截断文件会做 best-effort 清理，保留期约 `7` 天

`details.truncation` 里会暴露：

| 字段 | 含义 |
| --- | --- |
| `truncated` | 是否发生截断 |
| `alreadyTruncated` | 是否上游已经截断过 |
| `outputPath` | 完整输出路径 |
| `totalLines` | 原始总行数 |
| `totalBytes` | 原始总字节数 |

如果上游工具已经截断，`pi-base` 会复用上游 `outputPath`，不会重复落盘。

### 错误标记修复

`pi-base` 自己注册的工具会在错误结果的 `details` 中写入内部错误标记。全局 `tool_result` hook 会优先识别这个标记，再对旧结果保留少量文本启发式兜底。这样内置工具、LSP 工具、`find` wrapper 和动态 MCP 工具都能稳定补齐 `isError: true`。

### 状态栏

有 UI 时，`pi-base` 会在状态栏里展示：

- `YOLO`
- `MCP: x/y servers`
- `agent:<name>`

默认 agent 也会显示状态，值为 `agent:default`。

## 开发

```bash
npm run typecheck
npm test
npm run test:coverage
```

如果从 shell 用 `pi -p` 调试，记得对 prompt 做引用，避免 shell 先展开 `$(...)`、反引号、`$VAR` 或 glob。
