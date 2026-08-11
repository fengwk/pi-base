# pi-base 开发文档

这里存放面向高级用户、维护者和贡献者的配置与实现文档。首次安装和使用仍以仓库根目录的 [README](../README.md) 为准。

## 文档索引

- [架构概览](architecture.md)
  - 扩展启动顺序
  - 生命周期事件
  - 工具公共执行链
  - Agent、MCP、LSP、Goal 与 Subagent 的关系
- [Markdown Agent](agents.md)
  - Agent 文件格式
  - Tool、skill 与 subagent allowlist
  - 启动优先级和切换方式
- [开发者手册](development.md)
  - 本地开发
  - 仓库结构
  - 新增或修改工具
  - 测试与发布检查
- [配置参考](configuration.md)
  - 配置路径
  - 合并规则
  - 全部顶层配置项
- [工具实现索引](tools/README.md)
  - 基础文件工具
  - LSP 工具
  - Subagent、Goal 与 MCP 动态工具

## 维护原则

- 文档描述当前实现，不记录会话过程或修改历史。
- 实现真值以 schema、配置校验和测试为准；文档层的公共机制只在[架构概览](architecture.md)中解释。
- [工具实现索引](tools/README.md)是工具文档的唯一完整清单；各工具页只描述本工具特有行为。
- 修改公共参数、默认值、错误语义或生命周期时，应同步更新对应文档。
