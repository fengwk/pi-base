<p align="center">
  🌐 <a href="lsp-goto-definition.md">English</a> · <a href="lsp-goto-definition.zh-CN.md">简体中文</a>
</p>

# `lsp_goto_definition`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Query symbol definitions by file position in a workspace with a configured LSP.

## Entry point

- Registration: [`src/lsp/tools-register.ts`](../../src/lsp/tools-register.ts)
- Execution: `executeLspGotoDefinition` in [`src/lsp/tool-helpers.ts`](../../src/lsp/tool-helpers.ts)
- Client: [`src/lsp/client.ts`](../../src/lsp/client.ts)
- Discovery: [`src/lsp/discovery.ts`](../../src/lsp/discovery.ts)
- Schema: [`src/schemas/lsp.ts`](../../src/schemas/lsp.ts)

## Parameters

| Parameter | Required | Default | Description |
|------|------|------|------|
| `path` | Yes | — | Local source file containing the symbol reference |
| `workdir` | No | session cwd | Base for resolving relative paths |
| `line` | Yes | — | 1-based line number |
| `character` | No | `0` | 0-based character offset |

## Execution chain

```text
resolve cwd/path
  -> pick LSP server by path
  -> discover workspace root
  -> LspManager.getClient
  -> check textDocument/definition capability
  -> open/sync document
  -> position encoding conversion
  -> textDocument/definition
  -> format locations
```

## Workspace and client

`path` serves two purposes:

1. Picks the server matched by suffix.
2. Derives the workspace root.

The workspace root is computed from `.git` boundaries, `rootMarkers`, and `firstMatchMarkers`. The client cache key contains the root, server id, and a server config fingerprint.

## Capability

Before sending a request, the tool checks whether the server declares `textDocument/definition`. If not declared, no request is sent and an error is returned; the error message includes alternative suggestions using `grep` or `read`.

## Position encoding

The caller uses character offsets of the visible text. The client converts between the following formats based on the position encoding declared by the server:

- UTF-8
- UTF-16
- UTF-32

## Result

Local definition format:

```text
/absolute/path/file.ts:42:3
```

JDTLS external class definitions keep the original `jdt://...` URI for continued use by `lsp_java_decompile`.

No results return `No results found`, which is not a tool error.

## Abort and timeout

- Both client initialization and requests accept an AbortSignal.
- Each request uses the server's `requestTimeoutMs`, 60000 ms by default.
- Cancellation sends `$/cancelRequest`.

## Related tests

- [`tests/lsp-tools.test.ts`](../../tests/lsp-tools.test.ts)
- [`tests/lsp-client.test.ts`](../../tests/lsp-client.test.ts)
- [`tests/lsp-discovery.test.ts`](../../tests/lsp-discovery.test.ts)
- [`tests/lsp-tools-render-behavior.test.ts`](../../tests/lsp-tools-render-behavior.test.ts)
