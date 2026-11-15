<p align="center">
  🌐 <a href="write.md">English</a> · <a href="write.zh-CN.md">简体中文</a>
</p>

# `write`

[← 工具索引](README.zh-CN.md) · [公共架构](../architecture.zh-CN.md)

## 作用

创建新文件，或用完整内容覆盖已有文件。

## 入口

- 注册：[`src/write-register.ts`](../../src/write-register.ts)
- 执行：[`src/write-core.ts`](../../src/write-core.ts)
- Schema：[`src/schemas/write.ts`](../../src/schemas/write.ts)
- Prompt：[`prompts/write.md`](../../prompts/write.md)

## 参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `path` | 是 | — | 新建或完整覆盖的文件 |
| `content` | 是 | — | 完整文件内容 |
| `workdir` | 否 | session cwd | 相对路径解析基准 |

## 执行链

```text
参数校验
  -> 解析 path
  -> 文件变更队列
     -> stat/read existing target
     -> 按共享替换式解码读取文本
     -> 确定输出 encoding/BOM
     -> encode content
     -> mkdir parent
     -> 原地写入同一路径
  -> LSP sync observer
  -> Created/Overwrote result
```

## 新文件

- 父目录通过 recursive `mkdir` 创建。
- `content` 中的标准声明可指定编码（XML、CSS、HTML、Python/Ruby 注释、JSP）；否则默认使用 UTF-8。解码规则与 [read](read.zh-CN.md#文本读取) 共用。
- `content` 以 U+FEFF 开头且编码支持 BOM 时会生成相应 BOM，包括 UTF-16/32 的字节序形式。
- `content` 中的换行按调用方原样写入。

## 覆盖已有文件

已有目标必须经 `stat` 判断为普通文件。写入前读取原始字节并用共享替换式 decoder 按文本解码：

- 拒绝二进制文件，且不修改原文件。声明标签不受支持时仍会失败。
- 非法字节解码为 U+FFFD (�)；覆盖会重新编码整份解码文本，因此未选中的损坏字节不会被保留。
- BOM 优先：保留已有 encoding 与 BOM，`content` 中的声明必须解析为同一编码。
- 无 BOM 时，`content` 中的声明决定新编码，可以转换文件；去掉非 UTF-8 声明会被拒绝：`The new content removes the {name} declaration of {path}.`。
- 输出编码无法表示的文本会报出字符、码点与行号。
- 不自动保留已有换行风格；`content` 是完整文件的最终文本。

`write` 使用 `stat` 判断目标类型，因此符号链接按其目标进行普通文件判断，并由 `writeFile` 跟随；公共安全边界见[架构说明](../architecture.zh-CN.md#路径与文件写入)。队列内的操作直接把输出字节写入目标路径。符号链接会被跟随，解析后的文件保留原 inode，因此 hardlink、owner/group 与普通文件权限符合原地写入语义。校验失败不会写入，但原地写入不具备崩溃原子性：写入期间崩溃或磁盘写满可能留下部分内容。

## 并发与 abort

现有文件检查、编码选择、父目录创建和写入都位于文件变更队列。

写入开始前检查 AbortSignal。写入一旦开始就等待底层操作完成，因为文件系统写入无法被可靠回滚；完成后的 abort 不会隐藏已经发生的修改。

## Permission 与 LSP

- Permission 按目标路径匹配。
- 权限提示不包含完整 `content`。
- 成功后同步已打开的 LSP document。
- LSP observer 失败不会覆盖实际文件结果。

## 渲染

Write 调用有独立内容预览：

- 流式参数使用 10 行滚动窗口。
- settled/YOLO 下默认显示前 7 个内容行和剩余行数。
- 展开后可以查看完整调用内容。

结果正文只包含 `Created ...` 或 `Overwrote ...`。

## Error

- 缺少 `path` 或 `content`。
- 目标存在但不是普通文件。
- 目标存在但是二进制文件，或声明了不受支持的编码标签。
- 新内容与已有编码冲突。
- 读取或编码失败。
- 父目录创建失败。
- 文件写入失败。

所有错误转换为 `Error: ...` 和 `isError: true`。

## 相关测试

- [`tests/write-behavior.test.ts`](../../tests/write-behavior.test.ts)
- [`tests/edit-write-index.test.ts`](../../tests/edit-write-index.test.ts)
- [`tests/workdir.test.ts`](../../tests/workdir.test.ts)
- [`tests/special-file-tools.test.ts`](../../tests/special-file-tools.test.ts)
- [`tests/permission.test.ts`](../../tests/permission.test.ts)
- [`tests/tool-renderers.test.ts`](../../tests/tool-renderers.test.ts)
