# `read`

[← 工具索引](README.md) · [公共架构](../architecture.md)

## 作用

读取文本文件、目录和支持的图片，并为文本返回可定位的行号视图。

## 入口

- 注册：[`src/read-core.ts`](../../src/read-core.ts) `registerReadTool`
- Schema：[`src/schemas/read.ts`](../../src/schemas/read.ts)
- Prompt：[`prompts/read.md`](../../prompts/read.md)
- 图片降级：[`src/image-fallback.ts`](../../src/image-fallback.ts)

## 参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `path` | 是 | — | 文件、目录或图片路径 |
| `workdir` | 否 | session cwd | 相对路径解析基准 |
| `offset` | 否 | `1` | 文本起始行，1-based |
| `limit` | 否 | `200` | 最大文本行数，上限 2000 |

## 执行链

```text
校验参数
  -> 解析 workdir/path
  -> stat
     -> directory: readdir + 排序
     -> image: 模型能力判断 + 图片附件/skill 提示
     -> regular file: 大小检查 + 读取 + 解码
  -> 构造 header 和 numbered lines
  -> 返回结果
```

## 文本读取

文本分支在文件变更队列中重新执行 `stat` 和读取，避免与并发写入交错。

解码由 [`src/text-codec.ts`](../../src/text-codec.ts) 完成，覆盖：

- UTF BOM
- UTF-16 无 BOM 启发式
- 旧编码检测
- 二进制判断

文本结果格式：

```text
path: ...
ends_with_newline: yes|no
lsp: supported|unsupported

1|first line
2|second line
```

编号列宽按文件总行数计算。文件末尾换行不会额外生成一个编号空行。

## 限制

- `limit` 最大 2000。
- 文本候选文件超过 64 MiB 时在完整读取前拒绝。
- 单行最多展示 2000 字符。
- 非普通文件和二进制文件拒绝。
- 显示层会转义回车和 NUL。

达到读取窗口末尾但文件仍有内容时，结果附带下一次 `offset` 提示。

## 目录

目录项按名称排序，目录名称追加 `/`。目录读取不递归。

## 图片

直接支持扩展名：

- `.jpg`
- `.jpeg`
- `.png`
- `.gif`
- `.webp`
- `.bmp`

模型支持图片时委托 Pi 的图片 read 能力并保留附件。模型不支持时返回文本提示，引导读取 `skills/image-understanding/SKILL.md`。

## LSP 集成

`read` 使用目标文件所在目录创建 LSP resolver，并在 header 中报告：

- 当前后缀没有配置 LSP。
- 已配置且 server 可用。
- 已配置但 server 未安装。

它不会因为读取文件而自动打开 LSP document。

## Error 与截断

所有异常转换为 `Error: ...` 和 `isError: true`。

如果单行在 read 层被截断，结果写入 `details.upstreamTextTruncated`，使[公共结果处理链](../architecture.md#tool_result)知道完整文本已经无法从当前结果恢复。

## 相关测试

- [`tests/read.test.ts`](../../tests/read.test.ts)
- [`tests/image-fallback.test.ts`](../../tests/image-fallback.test.ts)
- [`tests/text-codec.test.ts`](../../tests/text-codec.test.ts)
- [`tests/line-endings.test.ts`](../../tests/line-endings.test.ts)
- [`tests/special-file-tools.test.ts`](../../tests/special-file-tools.test.ts)
- [`tests/workdir.test.ts`](../../tests/workdir.test.ts)
