<p align="center">
  🌐 <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

# pi-base 开发文档

本目录包含 pi-base 的配置、架构、工具实现和开发文档。安装与功能入口见仓库根目录的 [README](../README.zh-CN.md)。

## 文档索引

- [架构概览](architecture.zh-CN.md)
  - 扩展启动顺序
  - 生命周期事件
  - 工具公共执行链
  - Agent、原生 MCP、LSP、Goal 与 Subagent 的关系
- [Markdown Agent](agents.zh-CN.md)
  - Agent 文件格式
  - Tool、skill 与 subagent allowlist
  - 启动优先级和切换方式
- [开发者手册](development.zh-CN.md)
  - 本地开发
  - 仓库结构
  - 新增或修改工具
  - 测试与发布检查
- [配置参考](configuration.zh-CN.md)
  - 配置路径
  - 合并规则
  - 全部顶层配置项
- [MCP 迁移指南](mcp-migration.zh-CN.md)
  - 从 pi-base 自定义 MCP 迁移到 Pi 0.99.1 原生 MCP
  - `migrate-mcp.mjs` 迁移脚本用法与配置映射
- [配置示例](../examples/README.zh-CN.md)
  - `pi-base.json`
  - Markdown Agent
- [工具实现索引](tools/README.zh-CN.md)
  - 基础文件工具
  - LSP 工具
  - Subagent、Goal 与原生 MCP 工具

## 维护原则

- 实现真值以 schema、配置校验和测试为准；文档层的公共机制只在[架构概览](architecture.zh-CN.md)中解释。
- [工具实现索引](tools/README.zh-CN.md)是工具文档的唯一完整清单；各工具页只描述本工具特有行为。
- 修改公共参数、默认值、错误语义或生命周期时，应同步更新对应文档。
