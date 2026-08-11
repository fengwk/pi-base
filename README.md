# pi-base

`pi-base` 是 [Pi](https://github.com/earendil-works/pi) 的插件仓库，提供一套经过真实开发场景验证的基础插件与工具。

> **Less is more.** 只保留高频、稳定、可组合的能力，让 Agent 更专注地阅读代码、修改文件、运行命令和完成验证。

安装后即可使用，不需要先理解内部实现，也不需要维护复杂配置。

## 常用内置工具

下表是首次使用时最常见的内置工具。Agent 会从当前可用工具中选择合适方式；实际工具集还会受当前模型、Agent 的 `tools` 配置和运行时能力约束。用户通常只需要用自然语言说明目标、范围和约束。

| 工具 | 用途 | 怎么用 |
|------|------|--------|
| `read` | 读取文本、目录和支持的图片 | 告诉 Agent 要查看的路径；大文件可以要求分段读取 |
| `grep` | 在代码中搜索内容 | 说明关键词和搜索目录，例如“在 `src` 中搜索 `createUser`” |
| `find` | 按名称查找文件 | 说明文件名模式和目录，例如“在当前项目查找 `*.test.ts`” |
| `bash` | 运行构建、测试、Git 和其他命令 | 说明要执行的命令，必要时指定工作目录和超时 |
| `edit` | 精确替换已有文本 | 适合范围明确的单点修改 |
| `write` | 创建新文件或重写整个文件 | 适合新增文件和完整内容更新 |
| `apply_patch` | 一次完成多个文件的结构化修改 | 适合包含新增、更新、删除或移动的代码变更 |
| `lsp_goto_definition` | 跳转到符号定义 | 配置 LSP 后，让 Agent 从指定文件和位置查找定义 |
| `lsp_workspace_symbols` | 搜索工作区符号 | 配置 LSP 后，按类名、函数名或其他符号搜索 |
| `lsp_java_decompile` | 反编译 Java 依赖中的 class | 在 jdtls 项目中让 Agent 查看外部类实现 |
| `task` | 把独立任务委派给子 Agent | 在 Agent 中配置 `subagents` 后，让主 Agent 自动拆分和委派任务 |

默认文件修改能力会按当前模型投影为 `apply_patch` 或 `edit` / `write`，通常不需要用户关心具体工具。

Goal 与 MCP 工具会按运行状态动态出现；MCP 工具连接后仍受当前 Agent 的 `tools` 配置约束。完整列表见[工具实现索引](docs/tools/README.md)。

## 快速开始

### 1. 安装

要求 Node.js `>=22.19.0`，并已安装 Pi。

```bash
pi install git:github.com/fengwk/pi-base
```

只在当前项目安装：

```bash
pi install git:github.com/fengwk/pi-base -l
```

### 2. 启动 Pi

进入项目目录后启动：

```bash
cd /path/to/project
pi
```

### 3. 直接描述任务

例如：

```text
阅读这个项目，说明它的启动流程和核心模块。

找出当前失败测试的原因，修复后运行完整测试。

在 src 中找到 UserService 的定义和所有主要调用位置。
```

`pi-base` 会为 Agent 提供所需的读取、搜索、修改、命令和 LSP 工具。

## 可选配置

不创建配置文件也可以直接使用。需要自定义权限、LSP、通知、MCP 或其他运行时能力时，可添加：

| 作用域 | 路径 |
|--------|------|
| 全局 | `~/.pi/agent/pi-base.json` |
| 当前项目 | `<repo>/.pi/pi-base.json` |

修改配置后执行 `/reload`。全部字段、默认值、合并规则和示例见[配置参考](docs/configuration.md)。

## Agent 与扩展能力

- 在 `~/.pi/agent/agents/**/*.md` 中定义 [Markdown Agent](docs/agents.md)，通过 `pi --agent <name>` 或 `/agent <name>` 使用。
- 在 Agent 的 `subagents` 中声明可委派的 Agent，即可启用 [`task`](docs/tools/task.md)。
- 配置 `mcp.servers` 后，可使用[本地或远程 MCP 工具](docs/tools/mcp.md)。
- 使用 `/goal <objective>` 创建可持续推进和恢复的[长期目标](docs/tools/goal-tools.md)。
- 使用 `/mcp-status`、`/subagent` 和 `/goal status` 查看运行状态。

## 说明

- 桌面通知主要支持 Linux 和 WSL，其他平台按 best-effort 处理。
- 系统没有 `fd` 或 `rg` 时会尝试从其 GitHub Release 下载；设置 `PI_OFFLINE=1` 可禁用下载。
- `permission` 用于降低误操作风险，不是安全沙箱。需要强隔离时请使用容器、受限账户或系统级沙箱。

架构、开发、配置和工具实现文档见 [docs/](docs/)。

## 许可证

除单独标注的第三方组件外，本项目采用 [MIT License](LICENSE)。

第三方组件的来源、版权和适用许可证见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) 与 [LICENSES/](LICENSES/)。
