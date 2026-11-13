<p align="center">
  🌐 <a href="grep.md">English</a> · <a href="grep.zh-CN.md">简体中文</a>
</p>

# `grep`

[← 工具索引](README.zh-CN.md) · [公共架构](../architecture.zh-CN.md)

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
  -> ensureTool("rg")
  -> 目录搜索：先启动编码候选预扫描，再启动主搜索（并发）
  -> 解析 match events
  -> 解码候选文件；对声明编码的文件改用解码文本重新搜索
  -> 路径/行号格式化
  -> limit、长行、timeout 与未搜索提示处理
```

## ripgrep 参数

普通模式固定使用：

```text
--no-config
--json
--line-number
--color=never
--hidden
```

普通和多行搜索都忽略 ripgrep 配置（`RIPGREP_CONFIG_PATH`），避免环境选项改变工具的正则、literal、大小写或 glob 语义。需要主动使用自定义 ripgrep 配置时，通过 `bash` 执行。

可按参数增加：

- `--ignore-case`
- `--fixed-strings`
- `--glob`
- `--multiline`

系统没有 `rg` 时，内部 tool manager 会尝试下载官方 GitHub Release。`PI_OFFLINE=1`、`true` 或 `yes` 可禁用下载。

`include` glob 相对搜索 path 生效。目录搜索会在搜索根内部运行 ripgrep（因此 glob 跟随调用者给定的 path，符号链接目录也通过链接本身解析），glob 的前导 `./` 会被忽略，因为 ripgrep 永远不会匹配它。不含 `/` 的模式在任意深度匹配文件名。

## 目标预检查

- 目录可以直接搜索；目录内的二进制过滤交给 ripgrep。
- 单文件必须是可解码文本。声明了非 UTF-8 编码时按解码文本搜索；二进制或无法解码的文件直接报错并使用 `read` 的措辞，不会静默跳过。

## 结果格式

普通匹配：

```text
src/example.ts:42: matching line
```

目录搜索使用相对搜索根的路径；单文件搜索使用 basename。

ripgrep JSON 中的 base64 `bytes` 字段只用于路径显示；行文本按 UTF-8 偏移取片段。若事件缺少行文本，普通模式会回读文件并用共享 codec 解码一次。

### 文本编码

结果必须与 `read` 一致，因此目录搜索会在主搜索之前启动第二个并发 `rg` 进程：使用相同过滤条件执行 `rg --files-with-matches --encoding utf-8`，模式为 `coding[:=]|charset|<\?xml|pageEncoding|\x{FFFD}`。它列出唯一可能与纯 UTF-8 解码结果不同的文件：带声明样式的文件，以及不是合法 UTF-8 的文件。两次扫描并行运行，只在格式化结果时等待预扫描完成。

每个候选文件用 [`src/text-codec.ts`](../../src/text-codec.ts) 解码。UTF-8 文件保留 ripgrep 的原始结果；带 BOM 或声明了其他编码的文件，由 ripgrep 从 stdin 读取规范化后的解码文本重新搜索，因此使用同一正则引擎，行号与 `read` 一致。codec 拒绝的文件会被跳过并丢弃其匹配。

最终提示会列出被跳过的文件：

```text
[Not searched because the text encoding could not be determined: /abs/a.txt, /abs/b.txt, … and 3 more]
```

最多列出 10 个绝对路径并附带剩余数量；无论是否有匹配都会出现（无匹配时跟在 `No matches found` 之后）；所有候选都成功解码时不出现。

超过展示预算的行会以该行首个 ripgrep submatch 为中心的片段展示：submatch 的 UTF-8 字节偏移会映射回报告文本，因此长行深处的命中仍可见并保留两侧上下文。片段最多 500 码点，被裁掉的一端用 `…` 标记；裁切落在码点边界上，多字节字符和代理对不会被切开。多行 event 的每一行只按覆盖该行的匹配部分取片段。若事件没有 submatch 偏移，则沿用行首前缀截断。

## Limit 与截断

- 单个显示片段最多 500 码点，被裁切处另有 `…` 标记。
- `limit` 统计 match event。仅达到 `limit` 不算截断：只有 ripgrep 再报告至少一个后续 match event 时，才会出现提示和 `details.matchLimitReached`，且该 lookahead 匹配不会展示。
- 多行模式的 `limit` 统计 match event；一个 event 可能展示多行。
- 长行截断设置 `details.linesTruncated`。

这些语义性截断通过 metadata 标记，供[公共结果处理链](../architecture.zh-CN.md#tool_result)识别。

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
- [`tests/grep-excerpts.test.ts`](../../tests/grep-excerpts.test.ts)
- [`tests/grep-multiline-behavior.test.ts`](../../tests/grep-multiline-behavior.test.ts)
- [`tests/grep-multiline-errors.test.ts`](../../tests/grep-multiline-errors.test.ts)
- [`tests/search-tools.test.ts`](../../tests/search-tools.test.ts)
- [`tests/regressions.test.ts`](../../tests/regressions.test.ts)
- [`tests/timeout.test.ts`](../../tests/timeout.test.ts)
