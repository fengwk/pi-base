<p align="center">
  🌐 <a href="apply-patch.md">English</a> · <a href="apply-patch.zh-CN.md">简体中文</a>
</p>

# `apply_patch`

[← 工具索引](README.zh-CN.md) · [公共架构](../architecture.zh-CN.md)

## 作用

使用一个 freeform patch 完成多文件 Add、Update、Delete 和 Move。

## 入口

- 注册：[`src/apply-patch-tool.ts`](../../src/apply-patch-tool.ts)
- Parser/preflight/commit：[`src/apply-patch-core.ts`](../../src/apply-patch-core.ts)
- 显示：[`src/apply-patch-display.ts`](../../src/apply-patch-display.ts)
- Grammar：[`src/apply-patch-grammar.ts`](../../src/apply-patch-grammar.ts)
- Schema：[`src/schemas/apply-patch.ts`](../../src/schemas/apply-patch.ts)
- Prompt：[`prompts/apply_patch.md`](../../prompts/apply_patch.md)

## 参数

只有一个必填字符串：

| 参数 | 说明 |
|------|------|
| `patchText` | 从 `*** Begin Patch` 到 `*** End Patch` 的完整 patch |

`workdir` 不是顶层 JSON 参数；它只能作为 patch 内可选的 `*** Workdir:` 指令。

工具向 grammar-capable 模型提供 OpenAI Lark constrained sampling grammar。

## Patch 结构

```text
*** Begin Patch
*** Workdir: optional/root
*** Add File: src/new.ts
+export const value = 1;
*** Update File: src/old.ts
*** Move to: src/new-name.ts
@@ optional context
-old
+new
*** End of File
*** Delete File: src/obsolete.ts
*** End Patch
```

规则：

- Add body 每行以 `+` 开头，可以为空。
- Delete 不允许 body。
- Update 由一个或多个 `@@` hunk 组成。
- Update 可以包含 `*** Move to:`。
- 纯 Move 可以没有 hunk。
- 同一 patch 内每个 path 只能出现一次。

## 执行阶段

```text
patchText
  -> normalize / heredoc unwrap
  -> parse
  -> resolve workdir and paths
  -> preflight every file
  -> identity/conflict checks
  -> acquire canonical path queues
  -> commit files in patch order
  -> LSP observers
  -> result metadata
```

## Parser

Parser 处理：

- UTF BOM。
- LF、CRLF、CR。
- Begin/End 边界空白。
- `<<TOKEN`、`<<'TOKEN'`、`<<"TOKEN"` 及带 `cat ` 前缀的 heredoc wrapper。
- 可选 `*** Workdir:`，且只能位于 Begin Patch 后。

Malformed patch 在文件系统访问前失败。

## Hunk 匹配

Update 按以下层级寻找唯一匹配：

1. `exact`
2. `trimEnd`
3. `trim`
4. `unicode`

`unicode` 层执行以下规范化：

- `‘`、`’`、`‚`、`‛` 转为 `'`。
- `“`、`”`、`„`、`‟` 转为 `"`。
- `‐`、`‑`、`‒`、`–`、`—`、`―`、`−` 转为 `-`。
- `…` 转为 `...`。
- 不换行空格 U+00A0 转为普通空格。

关键规则：

- 每个 hunk 必须唯一匹配。
- `@@ context` 限制搜索起点。
- Hunk 按源文件顺序应用。
- `*** End of File` 要求匹配位于文件尾部。
- 只有新增行的 hunk 追加到文件末尾。
- 没有任何新增或删除的 Update 拒绝。

## Preflight

所有文件先完成 preflight，任何一项失败都不会开始提交。

Preflight 检查：

- Add 目标必须不存在。
- Update/Delete 源必须存在且为普通文本文件。
- 二进制文件拒绝。
- Move 源和目标不能是符号链接。
- Move 目标只能是普通文件或不存在。
- 路径不能重复解析到同一 canonical target。
- 检查 inode/device identity、hardlink/symlink alias。
- 检查输出父子层级冲突。
- 验证编码、BOM、换行和 hunk 结果可写回。

Preflight 会收集多个独立错误后统一报告。

## Commit

提交按 patch 中的文件顺序执行。

### Add

- 创建父目录。
- 使用 `wx` 独占创建，防止覆盖竞态。
- 非空内容使用 LF 连接并追加最终换行。
- 空 Add 创建零字节文件。

### Update/Delete

提交前重新读取当前文件并与 preflight 字节比较。文件已变化时拒绝 stale patch。

- Update 写回原路径。
- Delete 使用 `unlink`。

### Move

1. 再次检查目标状态。
2. 创建目标父目录。
3. 写目标。
4. 恢复 source mode。
5. 删除源文件。

已有普通目标文件可以覆盖。

## Partial commit

Preflight 是全量的，但提交不是事务。

如果后续文件在 commit 阶段失败：

- 之前成功的文件不会回滚。
- 返回 `partial: true`。
- `appliedFiles` 列出已提交文件。
- 失败路径标记 `failedPathState: "unknown"`。
- Move 中间失败时源和目标都不能假定保持原状态。

## 编码与换行

Update/Move 保留已有文件的：

- encoding
- BOM
- 行尾
- 最终换行状态

Add 使用 UTF-8/LF 语义。

## Permission

Permission 会先解析 patch intents：

- 普通 Update 继承 `edit`。
- Add/Delete 继承 `write`。
- Move 源和目标都继承 `write`。
- `permission.apply_patch` 作为额外覆盖层。
- 多目标按 `deny > ask > allow` 聚合。

权限 prompt 只展示 A/M/D 操作和路径，不复制 patch body。

## LSP

每个成功提交后：

- Add：同步目标。
- Update：同步源。
- Delete：关闭源 document。
- Move：关闭源并同步目标。

Commit 失败时关闭失败路径对应的 LSP document；Move 失败时同时关闭目标路径对应的 document。

## Diff 与渲染

- 文件 diff metadata 最多保存 400 个显示行。
- 每行最多 500 字符。
- `addedLines` / `removedLines` 始终统计完整 diff。
- Settled Add body 默认显示前 10 行，每行最多 1500 字符。
- Malformed patch 使用有界 raw preview。

## 相关测试

- [`tests/apply-patch-core.test.ts`](../../tests/apply-patch-core.test.ts)
- [`tests/apply-patch-tool.test.ts`](../../tests/apply-patch-tool.test.ts)
- [`tests/apply-patch-display.test.ts`](../../tests/apply-patch-display.test.ts)
- [`tests/apply-patch-permission.test.ts`](../../tests/apply-patch-permission.test.ts)
- [`tests/apply-patch-context-compression.test.ts`](../../tests/apply-patch-context-compression.test.ts)
- [`tests/model-tool-routing.test.ts`](../../tests/model-tool-routing.test.ts)
- [`tests/tool-renderers.test.ts`](../../tests/tool-renderers.test.ts)
