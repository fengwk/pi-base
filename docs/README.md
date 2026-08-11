<p align="center">
  🌐 <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

# pi-base Documentation

This directory contains pi-base configuration, architecture, tool implementation, and development documentation. For installation and feature entry points, see the [README](../README.md) at the repository root.

## Documentation index

- [Architecture](architecture.md)
  - Extension startup order
  - Lifecycle events
  - Shared tool execution chain
  - Relationships between Agent, MCP, LSP, Goal, and Subagent
- [Markdown Agents](agents.md)
  - Agent file format
  - Tool, skill, and subagent allowlists
  - Startup priority and switching
- [Developer guide](development.md)
  - Local development
  - Repository structure
  - Adding or modifying tools
  - Testing and release checks
- [Configuration reference](configuration.md)
  - Configuration paths
  - Merge rules
  - All top-level configuration options
- [Configuration examples](../examples/README.md)
  - `pi-base.json`
  - Markdown Agent
- [Tool implementation index](tools/README.md)
  - Basic file tools
  - LSP tools
  - Subagent, Goal, and MCP dynamic tools

## Maintenance principles

- The schema, configuration validation, and tests are the source of truth for implementations; documentation-level public mechanisms are only explained in the [Architecture](architecture.md).
- The [Tool implementation index](tools/README.md) is the only complete inventory of tool documentation; each tool page only describes behavior specific to that tool.
- When changing public parameters, defaults, error semantics, or lifecycle, update the corresponding documentation accordingly.
