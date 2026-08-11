<p align="center">
  🌐 <a href="lsp-workspace-symbols.md">English</a> · <a href="lsp-workspace-symbols.zh-CN.md">简体中文</a>
</p>

# `lsp_workspace_symbols`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Search symbols by name across the entire workspace via LSP.

## Entry point

- Registration: [`src/lsp/tools-register.ts`](../../src/lsp/tools-register.ts)
- Execution: `executeLspWorkspaceSymbols` in [`src/lsp/tool-helpers.ts`](../../src/lsp/tool-helpers.ts)
- Client: [`src/lsp/client.ts`](../../src/lsp/client.ts)
- Schema: [`src/schemas/lsp.ts`](../../src/schemas/lsp.ts)

## Parameters

| Parameter | Required | Default | Description |
|------|------|------|------|
| `path` | Yes | — | Local source file used to select the workspace/server |
| `workdir` | No | session cwd | Base for resolving relative paths |
| `query` | Yes | — | Symbol query string |
| `limit` | No | `50` | Local maximum number of displayed results; may be 0 |

## Execution chain

```text
resolve cwd/path
  -> pick server and workspace root
  -> LspManager.getClient
  -> check workspace/symbol capability
  -> workspace/symbol(query)
  -> local slice(limit)
  -> format name, kind, and URI
```

## Capability

When the server does not declare `workspace/symbol`, no request is sent; `grep`, `find`, or chunked `read` is suggested instead.

## Limit

`limit` only restricts the local display. The request itself still returns however many results the server decides.

Output format:

```text
UserService (Class) - file:///workspace/src/UserService.ts
createUser (Function) - file:///workspace/src/users.ts
```

Symbol kind numbers are mapped to standard LSP names; unknown values display as `kind N`.

No results return `No symbols found`.

## Usage boundaries

- `lsp_workspace_symbols` queries workspace symbols by symbol name.
- Text content search is provided by `grep`.
- File name lookup is provided by `find`.
- `path` must belong to the target workspace, otherwise the wrong server/root may be selected.

## Abort and timeout

Behavior matches the other LSP tools:

- Initialization and requests are cancellable.
- Request timeout is 60000 ms by default.
- Clients are reused and idle-evicted by `LspManager`.

## Related tests

- [`tests/lsp-tools.test.ts`](../../tests/lsp-tools.test.ts)
- [`tests/lsp-client.test.ts`](../../tests/lsp-client.test.ts)
- [`tests/lsp-discovery.test.ts`](../../tests/lsp-discovery.test.ts)
- [`tests/lsp-tools-render-behavior.test.ts`](../../tests/lsp-tools-render-behavior.test.ts)
