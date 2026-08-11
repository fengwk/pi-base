<p align="center">
  🌐 <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

# 工具实现索引

[文档首页](../README.zh-CN.md) · [公共架构](../architecture.zh-CN.md)

## 静态基础工具

- [`read`](read.zh-CN.md)
- [`grep`](grep.zh-CN.md)
- [`find`](find.zh-CN.md)
- [`bash`](bash.zh-CN.md)
- [`edit`](edit.zh-CN.md)
- [`write`](write.zh-CN.md)
- [`apply_patch`](apply-patch.zh-CN.md)

## LSP 工具

- [`lsp_goto_definition`](lsp-goto-definition.zh-CN.md)
- [`lsp_workspace_symbols`](lsp-workspace-symbols.zh-CN.md)
- [`lsp_java_decompile`](lsp-java-decompile.zh-CN.md)

## 动态工具

- [`task`](task.zh-CN.md)
- [Goal tools](goal-tools.zh-CN.md)
- [MCP tools](mcp.zh-CN.md)

## 公共机制

所有工具共享的 schema/prompt 分层、路径解析、错误标记、Permission、统一输出限制和渲染规则见[架构概览](../architecture.zh-CN.md)。本目录中的页面只记录各工具的参数、执行链和特有边界。
