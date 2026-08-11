<p align="center">
  🌐 <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

# Tool Reference

[Documentation home](../README.md) · [Shared architecture](../architecture.md)

## Static base tools

- [`read`](read.md)
- [`grep`](grep.md)
- [`find`](find.md)
- [`bash`](bash.md)
- [`edit`](edit.md)
- [`write`](write.md)
- [`apply_patch`](apply-patch.md)

## LSP tools

- [`lsp_goto_definition`](lsp-goto-definition.md)
- [`lsp_workspace_symbols`](lsp-workspace-symbols.md)
- [`lsp_java_decompile`](lsp-java-decompile.md)

## Dynamic tools

- [`task`](task.md)
- [Goal tools](goal-tools.md)
- [MCP tools](mcp.md)

## Shared mechanisms

The schema/prompt layering, path resolution, error marking, Permission, unified output limits, and rendering rules shared by all tools are described in the [architecture overview](../architecture.md). The pages in this directory only document each tool's parameters, execution chain, and tool-specific boundaries.
