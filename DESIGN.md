# pi-base v1 设计方案

状态：已实现并持续迭代。

`pi-base` 的目标是提供一套 **最小、稳定、清晰、适合 agent 使用** 的 Pi 本地工具基座。它基于 `pi-hashline-readmap` 的实践做裁剪与收敛，优先保证：

- agent 易用
- 不出错
- 不幻觉
- 工具作用清楚
- 协议无歧义

本文档是 **0 上下文可读** 的方案文档：不依赖此前对话才能理解。

---

## 1. 总体目标

`pi-base` v1 目标：

1. 提供一套最小但完整的本地 coding agent 工具集。
2. 单包交付，不拆成多个扩展仓。
3. 工具协议优先服务 agent，而不是服务协议形式美观。
4. 工具输出应尽量稳定、短、清晰，可直接驱动下一步动作。
5. 默认优先 correctness，不做静默修复。
6. 让 agent 有空间发挥能力，但工具要明确边界和失败条件。

---

## 2. 交付形态

## 2.1 单包交付

`pi-base` 以 **一个扩展包** 交付。

方案要点：

1. `read / edit / write` 与 LSP 放在同一包内实现。
2. 通过代码目录分层保持可维护性。
3. 通过 Pi 现有的工具激活机制做能力裁剪。

这样可以减少安装、升级、文档与激活复杂度。

## 2.2 只做代码层面分层

虽然不拆扩展，但代码层面仍分层，保持可维护性。

当前实现目录结构：

```text
pi-base/
├── DESIGN.md
├── index.ts
├── package.json
├── src/
│   ├── read.ts
│   ├── grep.ts
│   ├── bash-renderer.ts
│   ├── edit.ts
│   ├── write.ts
│   ├── hashline.ts
│   ├── binary-detect.ts
│   ├── edit-diff.ts
│   ├── path-utils.ts
│   ├── runtime.ts
│   ├── timeout.ts
│   ├── config.ts
│   ├── tool-output.ts
│   ├── tool-result.ts
│   ├── schemas/
│   ├── lsp/
│   │   ├── client.ts
│   │   ├── discovery.ts
│   │   └── tools.ts
└── prompts/
    ├── base.md
    ├── read.md
    ├── grep.md
    ├── find.md
    ├── bash.md
    ├── edit.md
    ├── write.md
    ├── lsp_diagnostics.md
    ├── lsp_goto_definition.md
    ├── lsp_workspace_symbols.md
    └── lsp_java_decompile.md
```

## 2.3 工具激活方式

Pi 原生已支持通过 CLI 和运行时控制工具激活，因此不需要靠拆扩展做裁剪。

可用能力：

1. CLI allowlist：`--tools`
2. CLI 启动时禁用 built-in：`--no-builtin-tools`
3. 扩展运行时切换：`pi.setActiveTools([...])`

交付原则：

- `pi-base` 提供完整 base 工具集
- v1 在当前 active tools 为空时默认全部启用
- 如果用户需要缩小工具面，可通过 CLI 或运行时能力控制激活集合

## 2.4 配置加载

`pi-base` 使用自己的一层最小配置加载，不依赖 Pi 原生 `settings.json` 字段扩展。

配置文件路径：

- 全局：`~/.pi/agent/pi-base.json`
- 项目：`<repo>/.pi/pi-base.json`

测试或临时运行可通过 `PI_BASE_GLOBAL_SETTINGS_PATH` 覆盖全局配置文件路径，避免写入真实用户配置。

优先级：

```text
项目 JSON > 全局 JSON > 内建默认值
```

v1 当前加载以下配置：

- `lsp.searchPaths`：除 `PATH` 外的额外搜索目录
- `lsp.servers`：完全用户定义的 server 表（取代 v0 阶段的 `disabledServers` / `serverCommands`）
- `permission`：按工具与通配路径 / 命令配置 `allow` / `ask` / `deny`
- `render.collapsedToolResultLines`：配置折叠状态下的工具结果预览行数
- `yolo`：可选的默认 YOLO 状态

> 注：v0 阶段曾用 `lsp.disabledServers` 和 `lsp.serverCommands` 做"覆盖内置表"的策略，**已被 v0.2 移除**。  
> 现在 `pi-base` 不再内置任何 server，全部由用户在 `lsp.servers` 里声明。  
> "禁用"一个 server 直接不写。LSP 子配置 schema 因此**只有 `searchPaths` + `servers` 两个字段**。

`index.ts` 会在扩展启动时读取配置，并调用 discovery 配置入口生效。

## 2.5 System prompt 注入

`pi-base` 统一注入一段 **工具说明片段** 到 system prompt。

它不是完整 system prompt，也不声明 assistant 身份。

提示词草案存放在：

```text
prompts/base.md
```

这段片段负责放置：

1. 工具组合建议
2. 全局使用边界
3. 常见工作流建议
4. 少量必须反复强调的 agent 规则

这样可以避免把相同建议重复写在每个工具说明里。

### system prompt 分层

#### A. base tool guide

放置跨工具组合规则，例如：

- 先用 `find`/`grep` 缩小范围，再用 `read`
- 修改已有文件先 `read` 再 `edit`
- `write` 适合新文件和整文件覆盖
- `bash` 用于构建、测试、git、外部 CLI，不用于代替文件读写搜改
- 如果有 LSP 能力，优先用 `lsp_diagnostics` 做单文件检查

#### B. tool prompt

每个工具自己的 `promptSnippet` / `promptGuidelines` 只放：

- 该工具特有的约束
- 参数含义
- 误用风险

不重复书写所有跨工具组合建议。

### v1 方案

v1 使用扩展事件在 agent 启动前追加这段工具说明片段。

这样可以：

1. 保持一个统一的全局使用说明
2. 随 active tools 动态变化时仍可扩展
3. 减少每个工具自己的提示词冗余

---

## 3. 设计原则

## 3.1 Agent 易用性优先

优先级：

1. agent 易用性
2. correctness
3. 不出错、不幻觉
4. 清晰
5. 稳定
6. 简洁

一个看起来“更聪明”的协议，如果更容易诱发幻觉、更容易误用，就不是更好的协议。

## 3.2 KISS

只做最少必要工具。

v1 只定义：

- `read`
- `grep`
- `find`
- `bash`
- `edit`
- `write`
- `lsp_diagnostics`
- `lsp_goto_definition`
- `lsp_workspace_symbols`
- `lsp_java_decompile`

## 3.3 明示失败

尤其是文件编辑：

- stale 就明确报错
- 始终按 agent 指定的位置和锚点执行
- 返回 fresh anchors / 局部上下文帮助 agent 重试

## 3.4 搜索范围由 agent 显式决定

`grep` / `find` 通过：

1. 必传 `path`
2. `grep` 有默认 timeout
3. `grep` 有清晰的超时提示

来约束大范围扫描风险。

harness 不预先替 agent 决定哪些目录永远不可搜索。

## 3.5 v1 采用工具级 stale 处理

v1 通过以下方式处理 stale：

- 工具级 stale guard
- 工具级 fresh anchors
- agent 显式重读/重试

这样可以：

1. 避免 prompt cache 被频繁打断
2. 避免 UI 历史与实际发给模型的上下文不一致
3. 保持 token 估算与 compact 语义更直观

## 3.6 文本协议优先

工具调用参数使用 JSON schema。

工具结果正文优先使用：

- 行导向
- 结构化纯文本
- 简短 header + 空行 + 正文

正文保持纯文本主协议，避免不必要的 JSON 转义和 Markdown 包装噪音。

---

## 4. v1 工具总览

`pi-base` v1 提供以下工具：

### 文件与搜索

1. `read`
2. `grep`
3. `find`
4. `edit`
5. `write`

### 命令执行

6. `bash`

### LSP

7. `lsp_diagnostics`
8. `lsp_goto_definition`
9. `lsp_workspace_symbols`
10. `lsp_java_decompile`

---

## 5. 通用协议约定

## 5.1 参数命名

统一使用短但自解释的参数名：

- `path`
- `offset`
- `limit`
- `pattern`
- `include`
- `timeoutSeconds`

说明：

- `read` 同时覆盖文件、目录、图片，所以统一使用 `path`
- LSP 工具统一使用 `path`，并通过该路径推断 workspace root 与 server 选择

## 5.2 输出正文格式

所有 core 工具结果正文优先采用：

```text
key: value
key: value

body...
```

例如：

```text
path: src/example.ts
kind: file
mediaType: text
offset: 41
limit: 6
totalLines: 120
hasMore: true
nextOffset: 47

41:91a|export function createDemoDirectory(): UserDirectory {
42:0f2|  const users: User[] = [];
43:3bc|  return { users };
44:ab1|}
45:7de|
46:9c4|export function addUser(name: string) {
```

## 5.3 错误正文格式

错误正文必须短、稳定、直接。

推荐格式：

```text
Error: Search timed out after 15s.
Hint: If a broad scan is truly necessary, rerun with an explicit timeoutSeconds value.
```

要求：

1. agent 一眼能看懂
2. 不堆无用字段
3. 如需机器可判断的错误码，放在 `details` metadata，而不是正文里浪费 token

## 5.4 全局 `tool_result` 后处理

`pi-base` 注册了一个全局 `tool_result` hook，统一处理：

### 5.4.1 `isError` 保真修复

部分上游 runtime 在某些错误路径下会丢失 `isError` 标志。`pi-base` 在 hook 层用**保守启发式**重建该标志（详见 §12.5）。

### 5.4.2 输出截断与持久化

超过 `MAX_LINES=2000` 或 `MAX_BYTES=50KB` 的输出会被截断，完整内容写入 `os.tmpdir()/pi-base-truncation/`，metadata 放在 `details.truncation`（详见 §12.4）。

如果上游已经截断（例如 Pi 内建 bash），`pi-base` 不重复落盘，但会**透传上游路径**到 `details.truncation.outputPath`。

## 5.4 Hashline

文本读取与编辑使用 hashline 作为局部校验坐标。

格式：

```text
LINE:HASH|TEXT
```

约定：

- `LINE`：1-based 绝对行号
- `HASH`：短 hash
- `TEXT`：显示文本

说明：

- hash 基于原始完整行计算
- 即使显示文本被截断，hash 仍对应完整原始行

## 5.5 超长单行保护

对于 `read` / `grep`：

- 默认按行工作
- 任意单行如果超过 `2000` 字符，只展示前 `2000` 字符
- 追加固定后缀：

```text
... (line truncated to 2000 chars)
```

这条规则的含义是：

1. `read` / `grep` 是导航和定位工具，不是任意超长文本搬运工具
2. agent 应依赖 hashline 锚点和后续编辑，而不是依赖超长行的完整展示文本

---

## 6. `read`

## 6.1 作用

`read` 负责：

1. 读取文本文件
2. 读取目录列表
3. 读取图片（仅对齐 Pi 原生图像能力）
4. 为后续 `edit` 提供 fresh hashlines
5. 在 LSP 可用时，直接告诉 agent 当前文件是否受 LSP 支持

## 6.2 参数

```ts
{
  path: string;           // required
  offset?: number;        // optional, default: 1
  limit?: number;         // optional, default: 200, max: 2000
}
```

## 6.3 行为

### 文本文件

- 返回 hashlines
- 支持 `offset/limit`
- 超长单行按统一规则截断

### 目录

- 返回目录项列表
- 子目录以 `/` 结尾

### 图片

支持：

- `jpg`
- `jpeg`
- `png`
- `gif`
- `webp`

图片走 Pi 原生图片读取链路，返回 attachment，不生成 hashlines。

### 二进制非图片

二进制非图片文件返回简短提示，不输出乱码文本。

## 6.4 输出头部

### 文本文件

```text
path: src/example.ts
kind: file
mediaType: text
offset: 41
limit: 6
totalLines: 120
hasMore: true
nextOffset: 47
lsp: supported (typescript)
```

如果 LSP 不可用：

```text
lsp: unsupported
```

如果未启用 LSP 能力：

该字段可以省略。

## 6.5 few-shot

```text
read({ path: "src/example.ts" })
```

```text
read({ path: "src/example.ts", offset: 120, limit: 40 })
```

```text
read({ path: "src/" })
```

```text
read({ path: "screenshot.png" })
```

## 6.6 mock 输出

### 文本文件

```text
path: src/example.ts
kind: file
mediaType: text
offset: 41
limit: 6
totalLines: 120
hasMore: true
nextOffset: 47
lsp: supported (typescript)

41:91a|export function createDemoDirectory(): UserDirectory {
42:0f2|  const users: User[] = [];
43:3bc|  return { users };
44:ab1|}
45:7de|
46:9c4|export function addUser(name: string) {
```

### 目录

```text
path: src/
kind: directory

example.ts
read.ts
edit.ts
utils/
```

### 单行超长文件

```text
path: dist/bundle.min.js
kind: file
mediaType: text
offset: 1
limit: 1
totalLines: 1
hasMore: false

1:8af|(()=>{var e="...very long content..."... (line truncated to 2000 chars)
```

### 图片

```text
path: screenshot.png
kind: file
mediaType: image
message: Image returned as attachment. Hashline anchors are not available for images.
```

## 6.7 与其它工具配合

- `read -> edit`
- `read -> bash`
- `read -> lsp_diagnostics`
- `read -> lsp_goto_definition`

---

## 7. `grep`

## 7.1 作用

`grep` 用于在文件内容中搜索模式，并返回匹配位置；它不返回可直接用于 `edit` 的 LINE:HASH anchors。需要修改时应先用 `read` 读取目标区域，获取足够上下文和 fresh anchors。

## 7.2 参数

```ts
{
  pattern: string;          // required
  path: string;             // required
  include?: string;         // optional, file filter glob
  ignoreCase?: boolean;     // optional, default: false
  literal?: boolean;        // optional, default: false
  limit?: number;           // optional, default: 100
  timeoutSeconds?: number;  // optional, default: 15
}
```

说明：

- `path` 必传，要求 agent 显式说明搜索范围
- `include` 用于限制文件类型，如 `*.ts`
- v1 不提供 `context` 参数；需要上下文或准备编辑时，agent 应继续调用 `read`

## 7.3 实现方向

- 底层使用 `rg`
- 超时逻辑由工具自身实现

## 7.4 超时提示

```text
Error: Search timed out after 15s.
Hint: Large-scale scans are discouraged. Narrow the path or pattern first. If a broad scan is truly necessary, rerun grep with an explicit timeoutSeconds value.
```

## 7.5 few-shot

```text
grep({ pattern: "createDemoDirectory", path: "src", literal: true })
```

```text
grep({ pattern: "TODO", path: ".", include: "**/*.ts", timeoutSeconds: 30 })
```

## 7.6 mock 输出

```text
tests/fixtures/small.ts:45: export function createDemoDirectory(): UserDirectory {
tests/fixtures/other.ts:12: const createDemoDirectory = () => {
```

### 单行超长命中

```text
dist/bundle.min.js:1: (()=>{var e="...very long content..."... (line truncated to 500 chars)

[Some lines truncated to 500 chars. Use read tool to see full lines]
```

## 7.7 与其它工具配合

- `grep -> read -> edit`
- `grep -> read`

---

## 8. `find`

## 8.1 作用

`find` 用于递归按文件名模式发现文件。

## 8.2 参数

```ts
{
  pattern: string;          // required, glob style
  path: string;             // required
  limit?: number;           // optional, default: 1000
}
```

`path` 必填。即使要在当前工作目录搜索，也必须显式传 `"."`。这能避免模型把“自己脑中当前目录”误当成工具的隐式搜索根。

## 8.3 实现方向

- 底层优先使用 `fd`
- v1 协议不承诺必须有 fallback
- 若有 fallback，也必须受同样 timeout 约束

## 8.4 few-shot

```text
find({ pattern: "*.ts", path: "src" })
```

```text
find({ pattern: "*.java", path: ".", limit: 200 })
```

## 8.5 mock 输出

```text
src/read.ts
src/edit.ts
src/write.ts
src/utils/hashline.ts
```

## 8.6 与其它工具配合

- `find -> read`
- `find -> grep`

---

## 9. `bash`

## 9.1 作用

`bash` 负责：

- build
- test
- git
- package manager
- 调用外部 CLI

## 9.2 参数

```ts
{
  command: string;          // required
  workdir: string;          // required
  timeoutSeconds?: number;  // optional, no default
}
```

## 9.3 行为

- 不设默认 timeout
- 不设默认工作目录，agent 必须显式传 `workdir`
- 只有显式传 `timeoutSeconds` 才启用超时
- 在 Linux / WSL / macOS 上，若宿主机 `$SHELL` 为 `bash` 或 `zsh`，则优先使用该 shell，并补常见启动文件以尽量贴近终端环境；Windows 保持当前稳定行为
- 输出保持 shell-like 纯文本

## 9.4 使用边界

工具文档必须明确告诉 agent：

- 用 `bash` 跑命令
- 不要用 `bash` 替代 repo 文件读写搜改
- 文件读取用 `read`
- 文件搜索用 `grep/find`
- 文件修改用 `edit/write`

## 9.5 few-shot

```text
bash({ command: "npm test", workdir: "." })
```

```text
bash({ command: "mvn -q test", workdir: ".", timeoutSeconds: 120 })
```

```text
bash({ command: "git status --short", workdir: "." })
```

## 9.6 mock 输出

```text
command: npm test
exitCode: 1
timedOut: false

> project@1.0.0 test
> vitest run

2 failed, 128 passed

FAIL src/read.test.ts
...
```

---

## 10. `edit`

## 10.1 作用

`edit` 负责对已存在文本文件做局部修改。

## 10.2 原则

- 必须基于 fresh hashlines
- stale 明示失败
- 始终按 agent 给出的锚点执行

## 10.3 参数

```ts
{
  path: string;  // required
  edits: Array<
    | { replace_lines: { start_anchor: string; end_anchor: string; new_text: string } }
    | { delete_lines: { start_anchor: string; end_anchor: string } }
    | { insert_before: { anchor: string; new_text: string } }
    | { insert_after: { anchor: string; new_text: string } }
  >;
}
```

说明：

- v1 保持和现有 `readmap` 迁移成本低
- v1 不要求 agent 复述完整旧文本块
- `replace_lines.new_text` 是原始替换内容；`insert_before.new_text` / `insert_after.new_text` 表示要插入到锚点行前/后的完整行内容，必要的分隔换行由工具补齐

## 10.4 stale 行为

如果锚点 mismatch：

1. 不写文件
2. 返回错误
3. 附带当前局部 fresh anchors

## 10.5 few-shot

```text
edit({
  path: "src/example.ts",
  edits: [
    {
      replace_lines: {
        start_anchor: "45:4bf",
        end_anchor: "45:4bf",
        new_text: "export function buildDemoDirectory(): UserDirectory {"
      }
    }
  ]
})
```

```text
edit({
  path: "src/example.ts",
  edits: [
    {
      replace_lines: {
        start_anchor: "45:4bf",
        end_anchor: "47:91a",
        new_text: "export function createDemoDirectory(): UserDirectory {\n  return { users: [] };\n}"
      }
    }
  ]
})
```

```text
edit({
  path: "src/example.ts",
  edits: [
    {
      delete_lines: {
        start_anchor: "60:abc",
        end_anchor: "60:abc"
      }
    }
  ]
})
```

```text
edit({
  path: "src/example.ts",
  edits: [
    {
      delete_lines: {
        start_anchor: "60:abc",
        end_anchor: "61:def"
      }
    }
  ]
})
```

```text
edit({
  path: "src/example.ts",
  edits: [
    {
      insert_before: {
        anchor: "20:abc",
        new_text: "const enabled = true;"
      }
    }
  ]
})
```

```text
edit({
  path: "src/example.ts",
  edits: [
    {
      insert_after: {
        anchor: "20:abc",
        new_text: "const enabled = true;"
      }
    }
  ]
})
```

## 10.6 mock 输出

### 成功

```text
Edit applied to src/example.ts.
Review the diff below. Lines prefixed with "+" or "|" carry the current LINE:HASH anchors for follow-up edits in this region.

| 44:ab1|}
- 45:91f|export function buildOldDirectory(): UserDirectory {
+ 45:3cd|export function buildDemoDirectory(): UserDirectory {
| 46:91a|  const users: User[] = [];
```

### stale

```text
Edit failed for src/example.ts. The anchor no longer matches the current file.
Use the refreshed anchors from the latest read/edit result for this region, or rerun read if you need broader context.
```

## 10.7 与其它工具配合

- `read -> edit`
- `grep -> read -> edit`
- `write -> edit`

---

## 11. `write`

## 11.1 作用

`write` 负责：

- 新建文本文件
- 整文件覆盖文本文件

## 11.2 参数

```ts
{
  path: string;     // required
  content: string;  // required
}
```

## 11.3 行为

- 自动创建父目录
- 覆盖已有文件
- 写完立即返回 hashlined 输出，方便继续 `edit`

## 11.4 few-shot

```text
write({ path: "src/new-module.ts", content: "export const demo = 1;\n" })
```

```text
write({ path: "src/config.ts", content: "export const config = { enabled: true };\n" })
```

## 11.5 mock 输出

```text
Created src/new-module.ts.
Use these LINE:HASH anchors for follow-up edits.

1:832|export const demo = 1;
2:5aa|
```

## 11.6 与其它工具配合

- `write -> edit`

---

## 12. LSP 进入 base

LSP 进入 `pi-base` core，而不是拆成独立扩展。

原因：

1. 它与 `read / edit / write` 强相关
2. 文件修改后需要同步给 LSP，才能保证结果可靠
3. Java 反编译和单文件诊断对 agent 价值很高

## 12.1 默认发现与配置

v0.2 起，**`pi-base` 不再内置任何 LSP server**，也**不内置任何 well-known 路径**。

要使用某个 LSP server，用户必须在 `pi-base.json` 里写一条 `lsp.servers.<id>`：

```json
{
  "lsp": {
    "searchPaths": [
      "~/.local/share/nvim/mason/bin"
    ],
    "servers": {
      "jdtls": {
        "command": ["jdtls"],
        "extensions": [".java"],
        "rootMarkers": ["pom.xml", "build.gradle", "settings.gradle"],
        "firstMatchMarkers": [".git"]
      },
      "typescript-language-server": {
        "command": ["typescript-language-server", "--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
        "firstMatchMarkers": [".git", "package.json", "tsconfig.json", "jsconfig.json"]
      },
      "gopls": {
        "command": ["gopls"],
        "extensions": [".go"],
        "firstMatchMarkers": [".git", "go.mod", "go.work"],
        "requestTimeoutMs": 60000
      }
    }
  }
}
```

### 设计取舍说明

为什么不内置"well-known" 路径：

1. **KISS**：hardcoded 路径是隐式约定，违反"config-driven"原则
2. **可移植**：mason 路径在不同 OS / 安装方式下可能不同
3. **用户控制**：如果用户想用非 mason 安装的 server，只要 `command` 写绝对路径即可

为什么不用 `disabledServers`：

- 没有"默认 server" 就不需要"禁用"
- 用户的 list 只写"想用的"，"不想用的" 直接不写

为什么不用 `serverCommands` 作为 override：

- `lsp.servers.<id>.command` 本身就是最终值，不需要"内置 + override" 两层

## 12.2 `requestTimeoutMs`

每个 server 可选配置 `requestTimeoutMs`，默认 `15000`。应用于：

- 每次 `send()` 调用（JSON-RPC 请求）
- `waitForPublishedDiagnostics` 等待 diagnostics 推送

典型场景：

- `gopls` 在没 `go.mod` 的大目录上 `workspace/symbol` 需要 30-60s → 配 `60000`
- `jdtls` 第一次启动本身可能慢 → 配 `60000`
- tsserver / pylsp 默认 15s 通常够

当请求 timeout 时，错误消息会**明确告诉用户**改哪个字段：

```text
Error: LSP request timeout (workspace/symbol) after 90000ms.
Increase lsp.servers.gopls.requestTimeoutMs if this server is legitimately slow.
```

## 12.3 能力预检

`LspClient.initialize()` 成功后，server 返回的 `serverCapabilities` 被缓存到 `LspClient` 实例。

对以下 3 个 method，调用前会做预检：

| Method | 检查的 capability 字段 |
|---|---|
| `workspace/symbol` | `serverCapabilities.workspaceSymbolProvider` |
| `textDocument/definition` | `serverCapabilities.definitionProvider` |
| `java/classFileContents` | jdtls-specific，`isJdtls()` 即可 |

如果不支持：

- 不发请求
- 立即返回清晰错误，包含 server id 和**替代工具建议**

`textDocument/publishDiagnostics` **不做预检**：jdtls 等 server 实际会推 diagnostics，但 initialize 响应的 capability field 命名（`publishDiagnosticsProvider` vs `diagnosticProvider`）不稳定。不预检 + 用 timeout 处理，是更稳的策略。

## 12.4 输出截断

`pi-base` 在 `tool_result` hook 层做一次**统一截断**：

- `MAX_LINES = 2000`
- `MAX_BYTES = 50 * 1024`（50KB）

被截断时：

- 完整输出写入 `os.tmpdir()/pi-base-truncation/<tool>_<timestamp>_<rand>.txt`
- `details.truncation` 暴露：
  - `truncated: true`
  - `outputPath: <path>`
  - `totalLines` / `totalBytes`
  - `alreadyTruncated: true`（如果上游已截断）

**上游已截断**的识别：

- 内建 `bash` 输出含 `Showing lines 1001-3000 of 3000. Full output: /tmp/pi-bash-...log]`
- 内建 `read` / `grep` 输出含 `... (line truncated to 2000 chars)`
- 内建长行截断 `... (line truncated to 2000 chars)`

如果识别到上游截断：

- `pi-base` **不重复落盘**
- 但仍把上游路径写到 `details.truncation.outputPath`

这样 agent 看到的"完整输出"永远只有一份。

## 12.5 `isError` 保真

`tool_result` hook 会**主动修复**丢失的 `isError` 标志。

启发式：

- `read` / `write` / `grep` / `lsp_*`：正文以 `Error:` 开头 → `isError = true`
- `edit`：正文以 `Edit failed` 或 `Validation failed` 开头 → `isError = true`
- `bash`：
  - 以 `Error:` 开头 **且** 末尾是 `Command exited with code N` 或 `Command timed out...` → `isError = true`
  - 不会把"成功命令打印了 `Error: xxx`"误判

这样即使上游 runtime 漏掉 `isError`（一些 session JSONL 测试里发现的真实问题），下游仍能正确处理。

## 12.6 同步原则

LSP 同步链路参考：

1. Neovim 的成熟 LSP 行为
2. 现有 OpenCode 与本地插件实践

必须保证：

- 首次打开文件：`didOpen`
- 已打开文件被修改：`didChange`
- 必要时：`didSave`
- 外部文件变化：watcher / mtime 同步

## 12.7 `lsp_diagnostics`

### 作用

获取单文件诊断，优先替代大规模构建来做快速问题检查。

### 参数

```ts
{
  path: string;                     // required
  severity?: "all" | "error" | "warning" | "information" | "hint"; // optional, default: "all"
}
```

### few-shot

```text
lsp_diagnostics({ path: "src/main/java/com/acme/App.java", severity: "error" })
```

### mock 输出

```text
12:8 error cannot find symbol UserService
27:3 error incompatible types: String cannot be converted to int
```

## 12.8 `lsp_goto_definition`

### 作用

从当前文件位置跳转到定义位置。

### 参数

```ts
{
  path: string;            // required, also used to resolve workspace root
  line: number;            // required, 1-based
  character?: number;      // optional, 0-based code point offset, default 0
}
```

规则：

- `line` 必传
- `character` 缺省为 `0`
- 若 server 未声明 `definitionProvider`，返回清晰错误而不是发请求

### few-shot

```text
lsp_goto_definition({ path: "src/example.ts", line: 45, character: 15 })
```

### mock 输出

```text
/absolute/path/to/src/services/user-service.ts:12:1
```

## 12.9 `lsp_workspace_symbols`

### 作用

按名字在工作区内搜索符号。

### 参数

```ts
{
  path: string;       // required, used to resolve workspace root
  query: string;      // required
  limit?: number;     // optional, default: 50
}
```

### few-shot

```text
lsp_workspace_symbols({ path: "src/main/java/com/acme/App.java", query: "UserService", limit: 20 })
```

### mock 输出

```text
UserService (Class) - file:///absolute/path/to/src/main/java/com/acme/service/UserService.java
UserServiceClient (Interface) - file:///absolute/path/to/src/main/java/com/acme/client/UserServiceClient.java
```

## 12.10 `lsp_java_decompile`

### 作用

查看 JDTLS 提供的第三方 class / jar 源码视图，避免 agent 走"解压 jar + 自己反编译"的糟糕路径。

### 参数

```ts
{
  path: string;           // required, any local .java file in the same workspace
  target: string;         // required, usually jdt://... or definition result line
}
```

限制：

- **只支持 jdtls server**。在非 jdtls 上调用会立即返回清晰错误，不会尝试发请求
- `target` 可以是：
  - 完整 `jdt://contents/.../X.class?...` URI
  - 完整的 workspace symbol / definition 输出行（自动从行尾提取 jdt URI）
  - `file://` 绝对路径的 `.class` 文件
  - 相对 `.class` 路径（相对 tool 的 `cwd`）

### few-shot

```text
lsp_java_decompile({
  path: "src/main/java/com/acme/App.java",
  target: "jdt://contents/java.base/java/lang/String.class?..."
})
```

### mock 输出

```text
package java.lang;

public final class String {
  ...
}
```

---

## 13. 提示文档要求

每个工具必须提供：

1. `description`
2. `promptSnippet`
3. `promptGuidelines`（可选；复杂、易误用或有强约束的工具建议提供）
4. 独立 `prompts/<tool>.md`
5. 至少 2 个正确的 few-shot（复杂或易误用工具建议 3 个以上）
6. 与其它工具如何配合的说明
7. 所有参数默认值说明

### few-shot 规则

few-shot 必须：

1. 使用真实工具名
2. 使用与 schema 一致的字段名
3. 不展示已经决定不支持的参数
4. 与 Pi 的调用风格一致，例如：

```text
read({ path: "src/example.ts" })
```

而不是伪代码、也不是错误的 JSON 片段。

---

## 14. 开发顺序

建议按以下顺序推进：

1. `read`
2. `edit`
3. `write`
4. `grep`
5. `find`
6. `bash`
7. LSP runtime
8. `lsp_diagnostics`
9. `lsp_goto_definition`
10. `lsp_workspace_symbols`
11. `lsp_java_decompile`

进入开发前，逐项确认：

1. 输入 schema
2. 输出正文格式
3. 错误正文格式
4. few-shot 示例
5. 与其它工具的配合方式
