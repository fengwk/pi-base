<p align="center">
  🌐 <a href="mcp-migration.md">English</a> · <a href="mcp-migration.zh-CN.md">简体中文</a>
</p>

# MCP 迁移指南：从自定义 MCP 迁移到 Pi 0.99.1 原生 MCP

[← 文档首页](README.zh-CN.md) · [原生 MCP 工具文档](tools/mcp.zh-CN.md) · [配置参考](configuration.zh-CN.md)

本指南说明如何将现有的 MCP 配置及 Agent 定义从旧版 `pi-base` 自定义 MCP 实现平滑迁移至 Pi 0.99.1 原生 MCP。

## 概述

在 Pi 0.99.1 中，核心运行时直接内置了原生的 MCP 支持。`pi-base` 采用该原生支持作为**唯一**的 MCP 实现，并彻底废弃旧版自定义 MCP 架构（`src/mcp/hub.ts`、`src/mcp/binding.ts`、进程级 Hub 注册表、连接 Lease 共享、`/mcp-status` 及自定义工具别名）。不再提供双轨兼容支持。

## 核心差异与架构对照

| 维度 | 旧版 `pi-base` 自定义 MCP | Pi 0.99.1 原生 MCP |
|------|---------------------------|-------------------|
| **配置文件** | `~/.pi/agent/pi-base.json`（`mcp` 块）或 `<repo>/.pi/pi-base.json` | `~/.pi/agent/mcp.json`（全局）或 `<project>/.pi/mcp.json`（受信任项目） |
| **顶层字段** | `"mcp": { "servers": { ... } }` | `"mcpServers": { ... }` |
| **工具命名** | `<server>_<tool>` 或自定义 `toolPrefix` | 经 `createMcpToolName` 生成的官方全名 `mcp__<server>__<tool>`（字符清洗为 `[A-Za-z0-9_-]`，超 64 字符或冲突哈希为 `..._<hash>`） |
| **工具暴露** | 所有工具直接向模型声明 | 迁移显式设置 `direct`；原生 Pi 未配置时默认为 `codemode` |
| **Agent Allowlist** | 在 `tools: [...]` 中声明旧别名 | pi-base Markdown Agent guard 按官方名称检查普通工具执行；空列表仍允许按条件注入 `task` / Goal runtime 工具。这不是通用 SDK 保证 |
| **进程模型** | 跨 root 与 subagent session 共享进程级 `McpHub`，基于 Lease 计数管理生命周期 | 按 Session 独立连接（`per-session connections`），在 `session_start` 建立、Session 销毁时释放 |
| **SDK 子 Session** | 自动继承父 session 共享的 Hub 资源 | `pi-base` Subagent 仅加载 MCP（`createMcpExtension()`），使用独立 direct 连接；通用 Pi SDK 则显式传入所需扩展 |
| **传输协议** | `stdio`、`streamable-http`、`sse`、`websocket` | `stdio` 与 `streamable-http`。旧版 `sse` 与 WebSocket（`websocket`/`ws`）**明确拒绝** |
| **超时时间** | 毫秒（`startupTimeoutMs`、`callTimeoutMs`） | 请求超时单位为秒（`Math.ceil(ms / 1000)`）；无等价启动超时参数 |
| **管理命令** | `/mcp-status` 命令，底部显示 server 连接数 | `/mcp` 交互式 TUI 命令，`pi mcp` CLI 命令族（`add`、`remove`、`list`、`login`、`logout`） |
| **环境变量** | 整值 `$VAR` 或 `${VAR}` | `${NAME}` 或命令执行输出 `!command` |

## 迁移脚本：`scripts/migrate-mcp.mjs`

仓库提供了用于执行配置转换与工具引用重命名的迁移脚本。该脚本为离线工具，不连接外部 server，也不执行密钥展开。

### CLI 命令语法

脚本文件本身未设可执行权限，请使用 `node` 执行：

```bash
node scripts/migrate-mcp.mjs --config <pi-base.json> [--tool-map <input.json>] [--references <path>]... [--apply]
```

### 参数与选项说明

- `--config <path>`（必填）：源 `pi-base.json` 配置文件路径。
- `--apply`（可选）：脚本默认行为为 **dry-run**（演练模式）。不加 `--apply` 时，脚本仅校验输入、构建迁移计划，并输出受影响文件数、显式别名数等统计摘要和警告，**绝不打印 diff，也绝不输出任何配置正文或密钥值**（敏感配置在日志中全部遮蔽处理）。显式添加 `--apply` 才会将变更写入磁盘。
- `--tool-map <path>`（可选）：由用户提供的**输入** JSON 映射文件路径（格式为 `{ "<old_alias>": "mcp__<server>__<tool>" }`）。脚本**绝不会自动生成或写入该文件**。由于旧版的别名或自定义/空 `toolPrefix` 在离线状态下无法自动探测，用户必须在脚本外部（根据文档或实际运行 server）核对并准备好别名映射文件，再通过 `--tool-map` 传入。
- `--references <path>`（可选，可重复传参）：引用了工具名称的下游文件路径。每次传参仅指定一个文件路径，可重复多次（如 `--references file1.json --references file2.md`）。**仅支持常规非软链的 `.json` 和 `.md` 文件**：
  - 在 `.json` 文件中：对 `permission` 和 `render`（`collapsedToolResultLines`、`collapsedToolResultMaxChars`）块中的工具名做精确 key 重命名。除全局 `*` 外的通配符工具规则会被拒绝，需人工迁移。
  - 在 `.md` 文件中：仅支持 Agent frontmatter 中的简单 YAML 工具列表（行内 `tools: [a, b]` 或块状 `tools:\n  - a`）以及显式 token 单词替换。不支持复杂的 YAML 语法或模糊匹配，遇歧义直接报错拒绝。

### 安全与处理规则

1. **私有权限备份**：指定 `--apply` 时，脚本在修改任何目标文件前，都会在同级目录下创建命名为 `<target>.mcp-migration-<UUID>.bak`、文件权限为 `0600` 的私有备份文件，并在迁移完成后予以保留。
2. **同级生成 `mcp.json`**：脚本在 `--config` 所在同级目录下写入或合并 `mcp.json`。
3. **全部转换服务赋予 `exposure: "direct"`**：脚本转换出的每个 server 条目均显式配置 `"exposure": "direct"`，以保证依赖模型直接调用的旧 Agent 继续可用。
4. **字面量保留请求头**：请求头（`headers`）和环境变量定义按原样字面量完整复制，不做额外修改。
5. **超时单位换算**：毫秒超时（`callTimeoutMs` 或 server 级超时）通过 `Math.ceil(ms / 1000)` 向上取整换算为秒。由于原生 MCP 不设启动超时参数，原 `startupTimeoutMs` 会被跳过并输出警告日志。
6. **协议校验与拒绝**：远程服务若指定了 `sse` 或 `websocket`，直接报错拒绝；仅支持迁移 `streamable-http` 服务。
7. **密钥处理与核对提醒**：脚本按字面量原样复制配置，不执行自动的环境变量猜测或探测。由于旧版 pi-base 与原生 Pi MCP 的 `$VAR` / `${VAR}` 语法和展开时机可能存在差异，原生环境变量展开不保证与旧逻辑完全兼容，连接前必须人工核对环境变量和请求头配置。
8. **原配置安全移除**：在 `--apply` 模式下，仅当全部迁移计划执行成功后，才会从源 `pi-base.json` 中移除 `mcp` 块。
9. **冲突与回滚策略**：保留原生配置中的其他字段和 server；同名 server 内容不同、映射碰撞或引用歧义均在规划阶段报错，不写入任何文件。普通写入失败会恢复已提交文件并清理暂存文件，保留私有备份。应用时请停止活跃 Pi session：此操作不是跨文件的崩溃原子事务；若被中断，应先检查并恢复备份再重试。
10. **显式覆盖范围**：仅更新传入的引用路径和映射项。执行 `--apply` 前必须核对映射完整性，遗漏别名不会被自动推测。脚本不发现或迁移 history、session、auth、model 文件，传入已知受保护文件名及 history/session 目录中的引用会被拒绝。

## 手动迁移示例

### 1. 原 `pi-base.json` 配置

```json
{
  "permission": {
    "git_status": "allow",
    "filesystem_read_file": "allow"
  },
  "render": {
    "collapsedToolResultLines": {
      "filesystem_read_file": 10
    }
  },
  "mcp": {
    "startupTimeoutMs": 30000,
    "callTimeoutMs": 60000,
    "servers": {
      "filesystem": {
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
        "cwd": "~/work/project",
        "env": {
          "ROOT": "${PROJECT_ROOT}"
        }
      },
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

### 2. 用户自备的 `--tool-map` 输入 JSON

当 server `filesystem` 在旧别名下暴露 `filesystem_read_file` 工具时，准备如下映射文件：

```json
{
  "filesystem_read_file": "mcp__filesystem__read_file"
}
```

### 3. 迁移后生成的同级 `mcp.json`

保存在同级目录（`~/.pi/agent/mcp.json` 或 `.pi/mcp.json`）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": "~/work/project",
      "env": {
        "ROOT": "${PROJECT_ROOT}"
      },
      "timeout": 60,
      "exposure": "direct"
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "${DOCS_TOKEN}"
      },
      "timeout": 60,
      "exposure": "direct"
    }
  }
}
```

注意：
- 迁移后的所有 server 均配置 `"exposure": "direct"`。
- 原始请求头（`"Authorization": "${DOCS_TOKEN}"`）原样保留。

### 4. 清理后的 `pi-base.json`

从 `pi-base.json` 中移除 `mcp` 块，并在 `permission` 和 `render` 中使用官方规范名：

```json
{
  "permission": {
    "git_status": "allow",
    "mcp__filesystem__read_file": "allow"
  },
  "render": {
    "collapsedToolResultLines": {
      "mcp__filesystem__read_file": 10
    }
  }
}
```

### 5. 更新 Agent 声明文件（`.md`）

若 Agent 在 frontmatter 中显式声明了 MCP 工具：

**迁移前：**
```yaml
---
name: file-explorer
tools:
  - read
  - filesystem_read_file
---
```

**迁移后（配置为 `exposure: "direct"` 时）：**
```yaml
---
name: file-explorer
tools:
  - read
  - mcp__filesystem__read_file
---
```

若另行选择 `codemode` 暴露，pi-base Markdown Agent guard 要求同时授权
封装工具和 MCP 名称，见 [Agent 策略](agents.zh-CN.md#tool-allowlist)；
迁移脚本不会应用该可选配置。

## 迁移后核对验证

1. **连接前复核**：人工核对环境变量、请求头、启动命令和完整别名映射。原生 `${NAME}` 与 `!command` 的解析可能不同于旧字面量语义，迁移脚本不会求值。
2. **测试连接**：复核后在 Shell 中运行 `pi mcp list`，确认 server 连接成功并核对实际官方工具名。
3. **交互式检查**：启动 Pi session 并输入 `/mcp`，检查服务状态、暴露模式及工具挂载情况。
4. **重载运行时**：在已有活跃会话中执行 `/reload`，使新配置生效。
