# 工具实现索引

[文档首页](../README.md) · [公共架构](../architecture.md)

## 静态基础工具

- [`read`](read.md)
- [`grep`](grep.md)
- [`find`](find.md)
- [`bash`](bash.md)
- [`edit`](edit.md)
- [`write`](write.md)
- [`apply_patch`](apply-patch.md)

## LSP 工具

- [`lsp_goto_definition`](lsp-goto-definition.md)
- [`lsp_workspace_symbols`](lsp-workspace-symbols.md)
- [`lsp_java_decompile`](lsp-java-decompile.md)

## 动态工具

- [`task`](task.md)
- [Goal tools](goal-tools.md)
- [MCP tools](mcp.md)

## 公共机制

所有工具共享的 schema/prompt 分层、路径解析、错误标记、Permission、统一输出限制和渲染规则见[架构概览](../architecture.md)。本目录中的页面只记录各工具的参数、执行链和特有边界。
