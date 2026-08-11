# `lsp_java_decompile`

[← 工具索引](README.md) · [公共架构](../architecture.md)

## 作用

通过 JDTLS 获取外部 Java class 的源码或反编译文本。

## 入口

- 注册：[`src/lsp/tools-register.ts`](../../src/lsp/tools-register.ts)
- 执行：[`src/lsp/tool-helpers.ts`](../../src/lsp/tool-helpers.ts) `executeLspJavaDecompile`
- Client：[`src/lsp/client.ts`](../../src/lsp/client.ts)
- Schema：[`src/schemas/lsp.ts`](../../src/schemas/lsp.ts)

## 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `path` | 是 | 目标 Java workspace 中任意本地 `.java` 文件 |
| `workdir` | 否 | 相对路径解析基准 |
| `target` | 是 | `jdt://` URI、包含 URI 的结果行、`file://` URI 或 `.class` 路径 |

## 执行链

```text
解析 workspace path
  -> 选择 JDTLS client
  -> 检查 java/classFileContents capability
  -> target 中包含 jdt:// ?
     -> java/classFileContents
     -> 否：转换为 URI，执行 java.decompile command
  -> 返回源码文本
```

## Target 解析

如果 `target` 任意位置包含 `jdt://`，工具从该位置截取 URI。因此可以直接传入：

- 原始 `jdt://...`
- `lsp_goto_definition` 的完整结果行
- `lsp_workspace_symbols` 的完整结果行

其他 target：

- `file://` 保留。
- 本地路径转换为 `file://` URI。

## JDTLS 限制

工具要求 client 支持 `java/classFileContents`。当前 server 不是 JDTLS 或未声明能力时返回明确错误，不尝试 shell 解压 JAR。

JDTLS client 初始化会声明 `classFileContentsSupport`，并可按配置增强：

- Lombok javaagent。
- 基于项目 Java 文件数的 heap。
- Workspace `-data`。
- `JAVA_HOME_<version>` 选择。

这些增强属于 client 启动行为，不改变工具参数。

## 两条反编译路径

### `jdt://`

发送：

```text
java/classFileContents { uri }
```

适合 JDTLS 已解析出的 class URI。

### 文件 URI / class 路径

发送：

```text
workspace/executeCommand
command: java.decompile
arguments: [uri]
```

## Error

- 非 JDTLS server。
- 无法加载 class file contents。
- `java.decompile` 返回空值。
- Workspace/client 初始化失败。
- Abort 或 request timeout。

所有错误返回 `isError: true`。

## 推荐调用链

```text
lsp_workspace_symbols 或 lsp_goto_definition
  -> 得到 jdt:// URI
  -> lsp_java_decompile
```

## 相关测试

- [`tests/lsp-tools.test.ts`](../../tests/lsp-tools.test.ts)
- [`tests/lsp-client.test.ts`](../../tests/lsp-client.test.ts)
- [`tests/lsp-start.test.ts`](../../tests/lsp-start.test.ts)
- [`tests/lsp-tools-render-behavior.test.ts`](../../tests/lsp-tools-render-behavior.test.ts)
