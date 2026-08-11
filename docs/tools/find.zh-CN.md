<p align="center">
  🌐 <a href="find.md">English</a> · <a href="find.zh-CN.md">简体中文</a>
</p>

# `find`

[← 工具索引](README.zh-CN.md) · [公共架构](../architecture.zh-CN.md)

## 作用

使用 `fd` 按 glob 查找文件和目录。

## 入口

- 注册包装：[`src/index-impl.ts`](../../src/index-impl.ts) `registerFindTool`
- 执行：[`src/find-tool.ts`](../../src/find-tool.ts)
- Schema：[`src/schemas/find.ts`](../../src/schemas/find.ts)
- Prompt：[`prompts/find.md`](../../prompts/find.md)

## 参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `pattern` | 是 | — | glob 文件模式 |
| `path` | 是 | — | 搜索根目录 |
| `workdir` | 否 | session cwd | 相对路径解析基准 |
| `limit` | 否 | `1000` | 最大结果数 |
| `timeout_seconds` | 否 | 无 | 可选 timeout |

`path` 没有隐式默认值。搜索当前目录必须显式传 `"."`。

## 执行链

```text
注册包装器校验 path
  -> 解析 workdir 和绝对搜索根
  -> 可选 timeout signal
  -> ensureTool("fd")
  -> spawn fd
  -> 逐行读取 stdout
  -> 转换为相对搜索根路径
  -> 结果/limit/partial error
```

## fd 参数

固定参数：

```text
--glob
--color=never
--hidden
--no-require-git
--max-results <limit>
```

Pattern 中包含 `/` 时使用 `--full-path`。普通相对 full-path pattern 会前置 `**/`，使其能在搜索根的任意深度匹配。

系统没有 `fd` 时，内部 tool manager 会尝试下载官方 GitHub Release；`PI_OFFLINE=1` 可禁用。

## 路径输出

- 结果相对于 `path`。
- 分隔符统一显示为 `/`。
- 保留 fd 输出的目录尾部斜杠。
- 不对文件名做 `trim()`，因此尾随空格仍可表示。

## Limit

达到 `limit` 时结果追加提示并设置 `details.resultLimitReached`。

fd 的 `--max-results` 负责限制进程输出；本地层根据实际结果数量补充 metadata。

## Timeout 与 abort

Tool core 监听 AbortSignal 并终止 fd。注册包装器负责把可选 `timeout_seconds` 转为 timeout signal，并区分用户取消和内部 timeout。

## Error 与 partial output

- fd 不可用或下载失败：执行失败。
- spawn 失败：执行失败。
- 非零 exit code：返回退出码和 stderr。
- 非零退出但 stdout 已有内容时，结果保留 `Partial output` 并设置 `details.partialOutput`。
- 无结果返回 `No files found matching pattern`，不是错误。

## 相关测试

- [`tests/find-tool-native.test.ts`](../../tests/find-tool-native.test.ts)
- [`tests/search-tools.test.ts`](../../tests/search-tools.test.ts)
- [`tests/regressions.test.ts`](../../tests/regressions.test.ts)
- [`tests/workdir.test.ts`](../../tests/workdir.test.ts)
- [`tests/process-termination.test.ts`](../../tests/process-termination.test.ts)
- [`tests/tool-renderers.test.ts`](../../tests/tool-renderers.test.ts)
