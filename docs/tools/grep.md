# `grep`

[← 工具索引](README.md) · [公共架构](../architecture.md)

## 作用

使用 ripgrep 搜索文件内容，支持普通、literal、大小写不敏感和多行匹配。

## 入口

- 注册：[`src/grep-register.ts`](../../src/grep-register.ts)
- 执行：[`src/grep-core.ts`](../../src/grep-core.ts)
- Schema：[`src/schemas/grep.ts`](../../src/schemas/grep.ts)
- Prompt：[`prompts/grep.md`](../../prompts/grep.md)

## 参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `pattern` | 是 | — | 正则或 literal 文本 |
| `path` | 是 | — | 文件或目录 |
| `workdir` | 否 | session cwd | 相对路径解析基准 |
| `include` | 否 | — | 文件 glob |
| `ignore_case` | 否 | `false` | 忽略大小写 |
| `literal` | 否 | `false` | 固定字符串搜索 |
| `multiline` | 否 | `false` | 允许跨行匹配 |
| `limit` | 否 | `100` | 最大 match event 数 |
| `timeout_seconds` | 否 | `15` | 搜索 timeout |

## 执行链

```text
校验 pattern/path
  -> 解析 workdir/path
  -> stat 目标
  -> 单文件二进制预检查
  -> ensureTool("rg")
  -> spawn ripgrep --json
  -> 解析 match events
  -> 路径/行号格式化
  -> limit、长行和 timeout 处理
```

## ripgrep 参数

普通模式固定使用：

```text
--json
--line-number
--color=never
--hidden
```

可按参数增加：

- `--ignore-case`
- `--fixed-strings`
- `--glob`
- `--multiline`

系统没有 `rg` 时，内部 tool manager 会尝试下载官方 GitHub Release。`PI_OFFLINE=1`、`true` 或 `yes` 可禁用下载。

## 目标预检查

- 目录可以直接搜索。
- 单文件必须是普通文件。
- 单文件搜索会先读取最多 1 MiB 做二进制检测。
- 目录内的二进制过滤交给 ripgrep。

## 结果格式

普通匹配：

```text
src/example.ts:42: matching line
```

目录搜索使用相对搜索根的路径；单文件搜索使用 basename。

ripgrep JSON 中的 base64 `bytes` 字段会经过文本解码。若事件缺少行文本，普通模式会按行号回读文件。

## Limit 与截断

- 单个显示行最多 500 字符。
- 达到 `limit` 时终止 ripgrep 并设置 `details.matchLimitReached`。
- 多行模式的 `limit` 统计 match event；一个 event 可能展示多行。
- 长行截断设置 `details.linesTruncated`。

这些语义性截断通过 metadata 标记，供[公共结果处理链](../architecture.md#tool_result)识别。

## Timeout 与终止

`timeout_seconds` 使用独立 AbortSignal。独立 timeout signal 返回 `Search timed out`；父级 abort 返回 abort。

子进程通过 [`src/process-termination.ts`](../../src/process-termination.ts) 终止进程树。

## Error

- ripgrep exit code `0`：有匹配。
- exit code `1`：无匹配，返回 `No matches found`。
- 其他 exit code：返回 stderr 错误。
- 非普通文件、二进制文件、无效正则和下载失败均返回 `isError: true`。

## 相关测试

- [`tests/grep-native.test.ts`](../../tests/grep-native.test.ts)
- [`tests/grep-multiline-behavior.test.ts`](../../tests/grep-multiline-behavior.test.ts)
- [`tests/grep-multiline-errors.test.ts`](../../tests/grep-multiline-errors.test.ts)
- [`tests/search-tools.test.ts`](../../tests/search-tools.test.ts)
- [`tests/regressions.test.ts`](../../tests/regressions.test.ts)
- [`tests/timeout.test.ts`](../../tests/timeout.test.ts)
