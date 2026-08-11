<p align="center">
  🌐 <a href="lsp-goto-definition.md">English</a> · <a href="lsp-goto-definition.zh-CN.md">简体中文</a>
</p>

# `lsp_goto_definition`

[← 工具索引](README.zh-CN.md) · [公共架构](../architecture.zh-CN.md)

## 作用

在已配置 LSP 的工作区中，根据文件位置查询符号定义。

## 入口

- 注册：[`src/lsp/tools-register.ts`](../../src/lsp/tools-register.ts)
- 执行：[`src/lsp/tool-helpers.ts`](../../src/lsp/tool-helpers.ts) `executeLspGotoDefinition`
- Client：[`src/lsp/client.ts`](../../src/lsp/client.ts)
- Discovery：[`src/lsp/discovery.ts`](../../src/lsp/discovery.ts)
- Schema：[`src/schemas/lsp.ts`](../../src/schemas/lsp.ts)

## 参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `path` | 是 | — | 包含符号引用的本地源码文件 |
| `workdir` | 否 | session cwd | 相对路径解析基准 |
| `line` | 是 | — | 1-based 行号 |
| `character` | 否 | `0` | 0-based character offset |

## 执行链

```text
解析 cwd/path
  -> 根据 path 选择 LSP server
  -> 发现 workspace root
  -> LspManager.getClient
  -> 检查 textDocument/definition capability
  -> 打开/同步 document
  -> 位置编码转换
  -> textDocument/definition
  -> 格式化 locations
```

## Workspace 与 Client

`path` 同时承担两个作用：

1. 选择后缀匹配的 server。
2. 推导 workspace root。

Workspace root 按 `.git` 边界、`rootMarkers` 和 `firstMatchMarkers` 计算。Client cache key 包含 root、server id 和 server config fingerprint。

## Capability

工具在发送请求前检查 server 是否声明 `textDocument/definition`。未声明时不发送请求并返回错误；错误消息包含使用 `grep` 或 `read` 的替代建议。

## 位置编码

调用方使用可见文本的 character offset。Client 根据 server 宣告的 position encoding 在以下格式之间转换：

- UTF-8
- UTF-16
- UTF-32

## 结果

本地定义格式：

```text
/absolute/path/file.ts:42:3
```

JDTLS 外部 class 定义保留原始 `jdt://...` URI，供 `lsp_java_decompile` 继续使用。

没有结果返回 `No results found`，不是工具错误。

## Abort 与 timeout

- Client 初始化和请求都接受 AbortSignal。
- 每个请求使用 server 的 `requestTimeoutMs`，默认 60000 ms。
- 取消时发送 `$/cancelRequest`。

## 相关测试

- [`tests/lsp-tools.test.ts`](../../tests/lsp-tools.test.ts)
- [`tests/lsp-client.test.ts`](../../tests/lsp-client.test.ts)
- [`tests/lsp-discovery.test.ts`](../../tests/lsp-discovery.test.ts)
- [`tests/lsp-tools-render-behavior.test.ts`](../../tests/lsp-tools-render-behavior.test.ts)
