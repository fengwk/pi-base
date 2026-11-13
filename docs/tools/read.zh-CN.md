<p align="center">
  🌐 <a href="read.md">English</a> · <a href="read.zh-CN.md">简体中文</a>
</p>

# `read`

[← 工具索引](README.zh-CN.md) · [公共架构](../architecture.zh-CN.md)

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
| `column_offset` | 否 | `1` | 首行返回内容的起始列，1-based Unicode 码点；仅文本读取支持 |

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

解码是确定性的，由 [`src/text-codec.ts`](../../src/text-codec.ts) 完成：

- UTF BOM 优先决定编码（UTF-32 先于 UTF-16 判断）；带 BOM 的文件按解码后的字符判断二进制。
- 否则由标准声明决定：字节 0 处的 XML `encoding`、字节 0 处的 CSS `@charset`、HTML head 的 `meta charset` / `http-equiv`（前 1024 字节）、第 1 或第 2 行的 Python/Ruby 编码注释（`coding[:=]`、`fileencoding=`、`encoding:`），以及 JSP page 指令中的 `pageEncoding` 或 `contentType` 内的 `charset`（前 1024 字节）。其他位置的相似文本不是声明。
- HTML/CSS 标签按 Encoding Standard 解析，其他来源按 IANA 名称解析，Python/Ruby 注释先经过 CPython 的 `get_normal_name`；每个标签只对应一个规范名称（`GBK`、`Big5`、`Shift_JIS`、`ISO-8859-1` 等）。
- 无 BOM 也无声明时，只接受合法 UTF-8。
- 二进制判定为前 8000 字节内出现 NUL（Git 规则）；其他控制字符仍视为文本。

声明必须与内容一致：非 UTF-8 声明遇上包含非 ASCII 字符的合法 UTF-8 时视为冲突；字节必须能无损解码并重编码。

文本结果格式：

```text
path: ...
ends_with_newline: yes|no
encoding: GBK            (仅当编码不是 UTF-8)
lsp: supported|unsupported

1|first line
2|second line
```

`encoding:` 行给出解码使用的编码，编号正文因此不含歧义；仅有 UTF-8 BOM 时不出现该行。

不是 UTF-8 且没有声明的文件会被拒绝，并给出转换示例；二进制文件按二进制拒绝。不支持的标签、声明冲突与无法无损解码的字节会同时说明文件、编码与声明位置。

编号列宽按文件总行数计算。文件末尾换行不会额外生成一个编号空行。续读提示放在编号正文之外，不会把截断说明追加进文件内容片段。

## 限制

- `limit` 最大 2000。
- 文本候选文件超过 64 MiB 时在完整读取前拒绝。
- 单行最多展示 2000 个 Unicode 码点。
- 非普通文件和二进制文件拒绝。
- 不是 UTF-8 且没有声明的文件拒绝而不是猜测；请转换为 UTF-8 或添加标准声明。
- 显示层会转义回车和 NUL。
- `column_offset` 只作用于返回窗口的第一行；列超出该行内容时拒绝，列 1 对任意行都合法。
- `column_offset` 大于 1 时，header 会多出一行 `column_offset:`，说明首个展示行从行中开始，避免被误认为完整源行。
- 目录与图片读取拒绝显式 `column_offset` 参数。

窗口在第一处单行片段达到上限的行停止，保证该行的剩余内容展示之前不会展示后续行；完整结果（header、正文与续读提示）始终保持在共享工具输出预算内（50 KiB / 2000 物理行），下游截断不会吃掉游标。

窗口未到达文件末尾时，结果附带精确下一位置的续读提示：按行续读给出 `offset`，行内被截断时额外给出 `column_offset`。

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

如果某行的片段在 read 层被截断，窗口在该行停止，结果写入 `details.upstreamTextTruncated` 和 `details.next`（`line` 与 `column`），使[公共结果处理链](../architecture.zh-CN.md#tool_result)知道完整文本已经无法从当前结果恢复；续读提示给出可执行的后续调用（`offset` 加 `column_offset`），从精确的下一个码点继续。

## 相关测试

- [`tests/read.test.ts`](../../tests/read.test.ts)
- [`tests/read-window.test.ts`](../../tests/read-window.test.ts)
- [`tests/image-fallback.test.ts`](../../tests/image-fallback.test.ts)
- [`tests/text-codec.test.ts`](../../tests/text-codec.test.ts)
- [`tests/line-endings.test.ts`](../../tests/line-endings.test.ts)
- [`tests/special-file-tools.test.ts`](../../tests/special-file-tools.test.ts)
- [`tests/workdir.test.ts`](../../tests/workdir.test.ts)
