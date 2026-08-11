<p align="center">
  🌐 <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

# pi-base

`pi-base` 是 [Pi](https://github.com/earendil-works/pi) 的插件包，提供文件读写、代码搜索、命令执行、LSP、MCP、Agent、Subagent 和 Goal 能力。这套工具组合经过互联网研发生产环境的实际使用验证。

> **Less is More.** 追求简单、稳定的工具组合。

越来越多的人把大量规则和工具注入 Agent，认为这样会让 Agent 更聪明，实际体验却恰恰相反。Agent 很聪明，过度约束一个聪明人会让他变得懒惰，Agent 也是如此。我们需要让 Agent 理解 what 与 why，并只提供少量帮助它发现 how 的工具，而不是不断堆叠 how、how、how……

## 内置工具

`pi-base` 提供以下内置工具。

| 工具 | 用途 |
|------|------|
| `read` | 读取文本、目录和支持的图片 |
| `grep` | 在文件或目录中搜索内容 |
| `find` | 按 glob 查找文件和目录 |
| `bash` | 运行构建、测试、Git 和其他命令 |
| `edit` | 精确替换已有文本 |
| `write` | 创建新文件或重写整个文件 |
| `apply_patch` | 结构化新增、更新、删除或移动多个文件 |
| `lsp_goto_definition` | 查询符号定义 |
| `lsp_workspace_symbols` | 搜索工作区符号 |
| `lsp_java_decompile` | 反编译 JDTLS 工作区中的外部 Java class |
| `task` | 创建或恢复 Subagent session |
| `create_goal` | 创建持久 Goal |
| `get_goal` | 读取 Goal 状态 |
| `update_goal` | 将 Goal 标记为完成或阻塞 |

未在 Agent `tools` 中指定文件修改工具时，模型 ID 包含 `gpt-` 且不包含 `gpt-4` 或 `oss` 的模型使用 `apply_patch`，其他模型使用 `edit` 和 `write`；显式配置不扩大权限，同时配置 `apply_patch` 与 `edit` / `write` 时只启用 `apply_patch`，模型 ID 包含 `gpt-` 且不包含 `gpt-4` 或 `oss` 的模型同时配置 `edit` 和 `write` 时也使用 `apply_patch`。

参数和使用边界见[工具文档](docs/tools/README.zh-CN.md)。

## 安装

需要已安装 [Pi](https://github.com/earendil-works/pi)。

```bash
pi install git:github.com/fengwk/pi-base
```

安装到当前项目：

```bash
pi install git:github.com/fengwk/pi-base -l
```

## 可选配置

配置文件支持全局和项目两个作用域：

| 作用域 | 路径 |
|--------|------|
| 全局 | `~/.pi/agent/pi-base.json` |
| 当前项目 | `<repo>/.pi/pi-base.json` |

可直接复制的全局配置和 Agent 示例见 [`examples`](examples/)；全部字段、默认值和合并规则见[配置参考](docs/configuration.zh-CN.md)。修改配置后执行 `/reload`。

## Agent 与扩展能力

- 在 `~/.pi/agent/agents/**/*.md` 中定义 [Markdown Agent](docs/agents.zh-CN.md)，通过 `pi --agent <name>` 或 `/agent <name>` 使用。
- 在 Agent 的 `subagents` 中声明可委派的 Agent，即可启用 [`task`](docs/tools/task.zh-CN.md)。
- 配置 `mcp.servers` 后，可使用[本地或远程 MCP 工具](docs/tools/mcp.zh-CN.md)。
- 使用 `/goal <objective>` 创建可持久化、可暂停和可恢复的 [Goal](docs/tools/goal-tools.zh-CN.md)。
- 使用 `/mcp-status`、`/subagent` 和 `/goal status` 查看运行状态。

## 说明

- [上下文压缩](examples/README.zh-CN.md#context-compression)默认关闭；它会用占位文本替换发送给模型的部分旧工具结果，仅在长时间、工具输出密集的 session 已产生明确上下文压力时开启。
- 桌面通知支持 Linux 和 WSL；其他平台不启用通知。
- 系统没有 `fd` 或 `rg` 时会尝试从其 GitHub Release 下载；设置 `PI_OFFLINE=1` 可禁用下载。
- `permission` 用于降低误操作风险，不是安全沙箱。需要强隔离时请使用容器、受限账户或系统级沙箱。

架构、开发、配置和工具实现文档见 [docs/](docs/)。

## 许可证

除单独标注的第三方组件外，本项目采用 [MIT License](LICENSE)。

第三方组件的来源、版权和适用许可证见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) 与 [LICENSES](LICENSES/)。
