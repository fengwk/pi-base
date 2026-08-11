<p align="center">
  🌐 <a href="lsp-workspace-symbols.md">English</a> · <a href="lsp-workspace-symbols.zh-CN.md">简体中文</a>
</p>

# `lsp_workspace_symbols`

[← 工具索引](README.zh-CN.md) · [公共架构](../architecture.zh-CN.md)

## 作用

通过 LSP 在整个工作区中按名称搜索符号。

## 入口

- 注册：[`src/lsp/tools-register.ts`](../../src/lsp/tools-register.ts)
- 执行：[`src/lsp/tool-helpers.ts`](../../src/lsp/tool-helpers.ts) `executeLspWorkspaceSymbols`
- Client：[`src/lsp/client.ts`](../../src/lsp/client.ts)
- Schema：[`src/schemas/lsp.ts`](../../src/schemas/lsp.ts)

## 参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `path` | 是 | — | 用于选择 workspace/server 的本地源码文件 |
| `workdir` | 否 | session cwd | 相对路径解析基准 |
| `query` | 是 | — | 符号查询字符串 |
| `limit` | 否 | `50` | 本地最大展示结果数，可为 0 |

## 执行链

```text
解析 cwd/path
  -> 选择 server 和 workspace root
  -> LspManager.getClient
  -> 检查 workspace/symbol capability
  -> workspace/symbol(query)
  -> 本地 slice(limit)
  -> 格式化名称、kind 和 URI
```

## Capability

Server 未声明 `workspace/symbol` 时不发送请求，直接建议使用 `grep`、`find` 或分段 `read`。

## Limit

`limit` 只限制本地显示。请求本身仍由 server 决定返回数量。

输出格式：

```text
UserService (Class) - file:///workspace/src/UserService.ts
createUser (Function) - file:///workspace/src/users.ts
```

Symbol kind 数字会映射为 LSP 标准名称；未知值显示为 `kind N`。

没有结果返回 `No symbols found`。

## 使用边界

- `lsp_workspace_symbols` 按符号名称查询工作区符号。
- 文本内容搜索由 `grep` 提供。
- 文件名查找由 `find` 提供。
- `path` 必须属于目标工作区，否则可能选择错误 server/root。

## Abort 与 timeout

行为与其他 LSP 工具一致：

- 初始化和请求可取消。
- Request timeout 默认 60000 ms。
- Client 由 `LspManager` 复用和 idle eviction。

## 相关测试

- [`tests/lsp-tools.test.ts`](../../tests/lsp-tools.test.ts)
- [`tests/lsp-client.test.ts`](../../tests/lsp-client.test.ts)
- [`tests/lsp-discovery.test.ts`](../../tests/lsp-discovery.test.ts)
- [`tests/lsp-tools-render-behavior.test.ts`](../../tests/lsp-tools-render-behavior.test.ts)
