<p align="center">
  🌐 <a href="lsp-java-decompile.md">English</a> · <a href="lsp-java-decompile.zh-CN.md">简体中文</a>
</p>

# `lsp_java_decompile`

[← Tool index](README.md) · [Shared architecture](../architecture.md)

## Purpose

Obtain source code or decompiled text of external Java classes through JDTLS.

## Entry point

- Registration: [`src/lsp/tools-register.ts`](../../src/lsp/tools-register.ts)
- Execution: `executeLspJavaDecompile` in [`src/lsp/tool-helpers.ts`](../../src/lsp/tool-helpers.ts)
- Client: [`src/lsp/client.ts`](../../src/lsp/client.ts)
- Schema: [`src/schemas/lsp.ts`](../../src/schemas/lsp.ts)

## Parameters

| Parameter | Required | Description |
|------|------|------|
| `path` | Yes | Any local `.java` file in the target Java workspace |
| `workdir` | No | Base for resolving relative paths |
| `target` | Yes | A `jdt://` URI, a result line containing a URI, a `file://` URI, or a `.class` path |

## Execution chain

```text
resolve workspace path
  -> pick JDTLS client
  -> check java/classFileContents capability
  -> does target contain jdt:// ?
     -> java/classFileContents
     -> no: convert to URI, run java.decompile command
  -> return source text
```

## Target resolution

If `target` contains `jdt://` anywhere, the tool extracts the URI from that position. So you can pass directly:

- A raw `jdt://...`
- A full result line from `lsp_goto_definition`
- A full result line from `lsp_workspace_symbols`

Other targets:

- `file://` is kept.
- Local paths are converted to `file://` URIs.

## JDTLS limitations

The tool requires the client to support `java/classFileContents`. When the current server is not JDTLS or does not declare the capability, a clear error is returned without attempting to extract JARs via shell.

The JDTLS client declares `classFileContentsSupport` during initialization and handles the following startup configuration:

- Lombok javaagent.
- Heap based on the project's Java file count.
- Workspace `-data`.
- `JAVA_HOME_<version>` selection.

These configurations are client startup behavior and do not change the tool parameters.

## Two decompilation paths

### `jdt://`

Sends:

```text
java/classFileContents { uri }
```

The `jdt://` path is used for class URIs already resolved by JDTLS.

### File URI / class path

Sends:

```text
workspace/executeCommand
command: java.decompile
arguments: [uri]
```

## Error

- Non-JDTLS server.
- Failed to load class file contents.
- `java.decompile` returns an empty value.
- Workspace/client initialization failure.
- Abort or request timeout.

All errors return `isError: true`.

## Call chain

```text
lsp_workspace_symbols or lsp_goto_definition
  -> get jdt:// URI
  -> lsp_java_decompile
```

## Related tests

- [`tests/lsp-tools.test.ts`](../../tests/lsp-tools.test.ts)
- [`tests/lsp-client.test.ts`](../../tests/lsp-client.test.ts)
- [`tests/lsp-start.test.ts`](../../tests/lsp-start.test.ts)
- [`tests/lsp-tools-render-behavior.test.ts`](../../tests/lsp-tools-render-behavior.test.ts)
