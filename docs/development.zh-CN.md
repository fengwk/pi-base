<p align="center">
  🌐 <a href="development.md">English</a> · <a href="development.zh-CN.md">简体中文</a>
</p>

# 开发者手册

## 环境要求

- Node.js `>=22.19.0`
- npm
- Pi 相关 peer dependencies 由仓库开发依赖提供

安装依赖：

```bash
npm install
```

验证命令：

```bash
npm run typecheck
npm test
npm run test:coverage
```

## 仓库结构

```text
index.ts                 Pi package 入口
src/                     TypeScript 实现
  schemas/               TypeBox 工具 schema
  lsp/                   LSP discovery/client/tools
  mcp/                   MCP transport/hub/tools
  subagent/              task 与子 session
  goal/                  Goal 状态与控制工具
  internal/              必要的 vendored helper
prompts/                 注入模型的工具说明
skills/                  随 package 提供的 skill
scripts/                 通知脚本
examples/                配置和 Agent 示例
tests/                   Vitest 测试
docs/                    开发与实现文档
```

## 修改现有工具

修改工具时检查以下位置：

1. `src/schemas/<tool>.ts` 的公共参数契约。
2. `prompts/<tool>.md` 的模型说明。
3. 注册模块中的 `prepareArguments`、renderer 和 execute wiring。
4. 核心执行文件的 abort、timeout、路径和错误语义。
5. Permission、LSP 同步、统一截断和 context compression 集成。
6. 对应测试及 renderer 测试。
7. `docs/tools/<tool>.md`。

不要只改执行函数而遗漏 schema、prompt 或测试。

## 新增静态工具

静态工具分层参考：

```text
src/schemas/example.ts
src/example-core.ts
src/example-register.ts
prompts/example.md
tests/example.test.ts
docs/tools/example.md
```

最小实现步骤：

1. 定义严格的 TypeBox schema。
2. 在 register 层加载 description 和 prompt snippet。
3. 在 `prepareArguments` 处理必要兼容映射。
4. 分离调用渲染、执行和结果渲染。
5. 使用 `withPiBaseErrorMarker` 包装错误结果。
6. 在 `src/index-impl.ts` 注册工具。
7. 将工具加入正确的 Agent tool projection。
8. 增加正常、失败、abort、timeout 和边界测试。

## Schema 与执行校验

Schema 是模型侧契约，但 execute 仍需校验直接调用场景。测试可能绕过 Pi 的 schema validation 直接调用 `execute`，因此核心执行函数不能假设参数已经可靠。

执行层校验：

- 必填字符串拒绝缺失和空白值。
- 数字使用统一 parser，并校验范围。
- 相对路径通过 `resolveToolWorkdir` 和 `resolveToCwd`。
- abort 在昂贵 I/O 前检查。
- timeout 使用 [`src/timeout.ts`](../src/timeout.ts)。

## 错误结果

工具执行的预期错误应返回：

```ts
{
  content: [{ type: "text", text: "Error: ..." }],
  isError: true
}
```

注册对象应使用 `withPiBaseErrorMarker`，使全局 `tool_result` hook 能稳定恢复 `isError`。

不要用异常承载普通用户错误；异常用于无法在核心层合理转换的意外失败。

## Renderer

调用和结果 renderer 要分别考虑：

- 参数仍在流式生成。
- 参数已经完成。
- 工具正在执行。
- 结果成功或失败。
- 折叠与展开。
- YOLO 下快速执行。
- 终端显示宽度。

公共 helper 位于 [`src/render.ts`](../src/render.ts)。文件修改工具还需要确保调用预览不改变真实写入内容。

## 文件与编码

文本工具共享以下约束：

- 只处理普通文件。
- 二进制文件应明确拒绝。
- 使用 [`src/text-codec.ts`](../src/text-codec.ts) 检测 BOM、UTF-16 和旧编码。
- `edit` / `apply_patch` 通过 [`src/line-endings.ts`](../src/line-endings.ts) 保留行尾。
- legacy encoding 写回必须无损；无法表示时失败而不是替换字符。
- 同一路径的读改写应进入文件变更队列。

## 子进程

`bash`、`find`、`grep` 和 LSP 都会启动子进程。

新增子进程逻辑时必须处理：

- 启动失败。
- stdout/stderr。
- 非零退出码。
- AbortSignal。
- timeout。
- 进程树终止。
- listener 和 timer cleanup。

通用终止逻辑位于 [`src/process-termination.ts`](../src/process-termination.ts)。

## 测试

Vitest 只收集 `tests/**/*.test.ts`，默认单测试超时 10 秒。

覆盖率阈值：

- statements：90%
- functions：90%
- lines：90%

`src/internal/**` 不计入直接覆盖率，通过上层集成行为验证。

测试约定：

- 使用 [`tests/helpers.ts`](../tests/helpers.ts) 创建临时工作区和 mock Pi registry。
- 测试意图写成简短注释。
- 测试临时文件放在系统临时目录。
- 不依赖开发者 HOME、固定 checkout 路径或全局配置。
- 涉及平台分支时显式模拟或使用平台条件。

## 文档同步

以下变化必须同步文档：

| 变化 | 文档 |
|------|------|
| 工具参数或默认值 | 对应 `docs/tools/*.md` |
| 配置字段或合并规则 | `docs/configuration.md` |
| 生命周期或模块关系 | `docs/architecture.md` |
| 用户安装和首用流程 | 根 `README.md` |
| 第三方来源 | `THIRD_PARTY_NOTICES` 和 `LICENSES` |

## 发布前检查

```bash
npm run typecheck
npm run test:coverage
npm audit
npm pack --dry-run
git diff --check
```

此外检查：

- 工作区无临时文件。
- README 和 docs 中的本地链接有效。
- JSON 示例可解析。
- 第三方代码的来源和许可证记录在 `LICENSES` 和 `THIRD_PARTY_NOTICES`。
- Git notes refs 为空；tracked files 不包含密钥、Token 或私人内部地址。
