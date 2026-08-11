# `edit`

[← 工具索引](README.md) · [公共架构](../architecture.md)

## 作用

在已有文本文件中执行精确字符串替换。

## 入口

- 注册与核心实现：[`src/edit-core.ts`](../../src/edit-core.ts)
- Schema：[`src/schemas/edit.ts`](../../src/schemas/edit.ts)
- Prompt：[`prompts/edit.md`](../../prompts/edit.md)
- 行尾：[`src/line-endings.ts`](../../src/line-endings.ts)
- 编码：[`src/text-codec.ts`](../../src/text-codec.ts)

## 参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `path` | 是 | — | 已有文本文件 |
| `old_string` | 是 | — | 要替换的精确文本 |
| `new_string` | 是 | — | 替换文本 |
| `replace_all` | 否 | `false` | 替换全部精确匹配 |
| `workdir` | 否 | session cwd | 相对路径解析基准 |

## 执行链

```text
参数校验
  -> old/new LF 规范化
  -> 解析 path
  -> 文件变更队列
     -> stat + read
     -> 文本解码
     -> 查找精确匹配
     -> 构造替换结果
     -> 保留编码/BOM/EOL
     -> write
  -> LSP sync observer
  -> numbered diff
```

## 匹配语义

- `old_string` 不能为空。
- `old_string` 和 `new_string` 必须不同。
- 默认要求 `old_string` 在文件中唯一。
- 没有匹配时失败。
- 多个匹配且 `replace_all=false` 时失败。
- `replace_all=true` 时替换全部非重叠匹配；重叠匹配会拒绝。

匹配前只把换行规范化为 LF，不会 trim 空白、缩进或标点。`old_string` 的空白、缩进、标点和换行必须与目标文件内容一致。

## 编码与换行

现有文件通过 `decodeTextFile` 读取，并保存：

- 原编码
- BOM
- 每行行尾
- 是否存在最终换行

替换文本在 LF 视图中应用，再由 `serializeLineEndingDocument` 写回。混合行尾文件优先复用被替换区域的行尾。

Legacy encoding 写回使用 round-trip 校验；新文本无法无损表示时失败。

## 并发

完整的 read-match-write 流程位于文件变更队列中。同一路径的并发修改会串行化，后一个 edit 在前一个提交后重新读取文件。

## Diff

成功结果生成带行号的 diff：

- 默认 4 行上下文。
- 多个 hunk 之间按距离决定是否合并。
- `details` 包含 diff、first changed line、绝对路径和替换数量。

调用 renderer 在参数流式生成时也会构造预览 diff，但预览不参与真实写入。

## Permission 与 LSP

- Permission 按 `path` 匹配。
- 权限提示不包含完整 old/new 正文。
- 成功写入后调用 `lspManager.syncFileIfOpen`。
- Observer 失败不会把已经提交的文件修改改写成工具失败。

## Error

以下情况返回 `isError: true`：

- 参数缺失。
- 目标不是普通文件。
- 二进制文件。
- old/new 相同。
- 找不到 old string。
- 匹配不唯一。
- replace-all 匹配重叠。
- 编码无法无损写回。
- 输出字节没有变化。

## 相关测试

- [`tests/edit-write-index.test.ts`](../../tests/edit-write-index.test.ts)
- [`tests/edit-diff.test.ts`](../../tests/edit-diff.test.ts)
- [`tests/edit-queue.test.ts`](../../tests/edit-queue.test.ts)
- [`tests/line-endings.test.ts`](../../tests/line-endings.test.ts)
- [`tests/text-codec.test.ts`](../../tests/text-codec.test.ts)
- [`tests/permission.test.ts`](../../tests/permission.test.ts)
- [`tests/tool-renderers.test.ts`](../../tests/tool-renderers.test.ts)
