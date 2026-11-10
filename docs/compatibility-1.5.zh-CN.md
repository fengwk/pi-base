# Pi 1.5 兼容性检查

## 结论

已完成面向 Pi `1.5.0` 的全仓库兼容性检查，并修复 3 处需要同步的行为。Pi `1.5.0` 下类型检查通过，82 个测试文件、1112 个测试用例全部通过。未发现剩余的已确认升级阻塞项。

检查以实际安装的 Pi `1.5.0` 类型声明和实现为依据，并对照升级前锁定的 `1.2.0`。`1.4.0` 的变化按 `1.5.0` 内的实现和 changelog 核查，没有单独运行 `1.4.0` 环境。

## 依赖与验证基线

- `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 的开发依赖从 `1.2.0` 升为 `1.5.0`，同步更新 lockfile。
- peer dependencies 保持 `^1.2.0`，不因本次检查无必要地提高最低版本。修复使用的公共 API 在 `1.2.0` 已存在，并在隔离的原版 `1.2.0` 依赖环境中通过类型检查及 66 个定向测试。
- 不把 Pi API 包或 `pi-schema` 加入 pi-base 的运行时 dependencies；宿主继续提供这些能力。
- 集成测试从 package manifest 读取目标版本，不再在多处硬编码 `1.2.0`。仍检查实际 SDK 版本与声明版本一致，不跳过行为断言。

## 已修复的问题

### 1. 自定义压缩的请求入口与鉴权

`src/compaction-model.ts` 原先把 `getApiKeyAndHeaders()` 返回的凭据、header、endpoint 和 env 显式传给 `compact()`，没有传入当前 session 的 registry stream。

这使自定义压缩脱离当前 registry 的请求路径，也没有继承 Pi 1.5 针对 OAuth 摘要鉴权的修复。对区分显式 API key 和已存储 OAuth 凭据的 provider，不能把已解析的 OAuth token 当作显式 key 再交回鉴权层。

现在仍执行鉴权预检查，但实际压缩通过 `ctx.modelRegistry.streamSimple()` 请求；请求时鉴权和 endpoint/header/env 配置由 registry 处理，不回放解析后的凭据。保留取消、thinking level、准备好的压缩切点以及失败回退。

验证：`tests/compaction-model.test.ts` 运行真实 `compact()` 和离线 registry stream，确认摘要成功、凭据未作为请求覆盖项传入、registry 的方法接收者正确，并禁止网络请求。

### 2. 自有 grep 没有继承 `rg --no-config`

Pi-base 自行实现 grep，不能自动继承 Pi 1.4 对 `RIPGREP_CONFIG_PATH` 干扰的修复。配置中的 `--fixed-strings` 可让工具声明的正则搜索变成 literal 搜索，出现错误的“无匹配”结果。

已在 `src/grep-core.ts` 的普通和多行两条执行路径加入 `--no-config`。

验证：`tests/grep-native.test.ts` 使用真实 rg 和包含 `--fixed-strings` 的配置文件，分别检查普通正则和跨行正则。两个用例在修复前失败，修复后通过。

### 3. 工具同步仍按数组顺序比较

Pi 1.5 把激活工具视为集合：保留仍激活工具的顺序，新工具追加到末尾。原生 MCP 异步发现工具时，实际顺序可能与 Agent frontmatter 不同。

`src/agent-support.ts` 原先按数组顺序判断是否同步，会在成员相同、顺序不同时反复调用 `setActiveTools()`。已改为比较成员；权限 allowlist 不变，增删工具仍会同步。

验证：新增用例检查重排不触发同步、缺少成员仍恢复。真实 MCP 集成测试检查完整且精确的成员列表，而不要求宿主按 frontmatter 重排。

## 全仓库检查范围与结果

| 范围 | 核查内容 | 结果 |
|---|---|---|
| 工具 schema、参数别名、grammar、错误链 | TypeBox → pi-schema 校验变化；`prepareArguments` 顺序；必填、数值范围、额外字段；校验错误不进入 execute | 未使用失效的 TypeBox 专属能力；新增测试通过宿主公共校验入口覆盖全部 14 个已注册工具 schema |
| 文件工具、bash、grep/find、LSP | 内置工厂签名、文件变更队列、执行包装、数字参数、abort/timeout、自有进程实现 | 工厂类型变化未造成类型错误；现有测试通过；grep 按上文修复 |
| 渲染与 TUI | `lastComponent`、流式参数、校验错误、`ToolExecutionComponent`、消息组件、keybindings | 现有缓存契约保留；新增渲染字段为可选项；校验错误仍保持 `isError` |
| Agent、Subagent、原生 MCP、codemode | 真实 SDK session、JITI loader、模块身份、异步工具发现、直接/嵌套调用、权限、trust、释放连接 | 全部相关集成测试通过，包括真实 loader 的父子 session 委派；工具顺序按上文适配 |
| 会话与 `/resume-all` | SessionManager 重载、选择器构造、恢复/分支、生命周期事件 | 未发现 API 断裂；现有测试通过 |
| Goal、上下文压缩、通知、配置 | settle/boundary 时序、消息去重、usage 字段、压缩参数、provider headers | 新字段为兼容性追加；Goal 的真实 session 回归通过；自定义压缩按上文修复 |
| vendored helper、脚本、技能、提示词、示例与文档 | fd/rg 资源架构选择、MCP 迁移格式、Pi 相关 API/配置依赖、依赖基线说明 | ARM 非支持架构已拒绝错误下载；迁移格式仍兼容；通知/图片脚本没有直接 Pi SDK 依赖；相关中英文文档已同步 |

其他核查结论：

- TypeBox 仍用于构建普通 JSON Schema，没有使用 `Type.Refine()`、`Type.BigInt()`、`Type.Undefined()`、codec 或 `Format.Set()` 等失效能力。无需改用另一套 schema builder。
- `Type`/`Static` 来自 `typebox`，未依赖 pi-ai 根入口移除的 TypeBox re-export；真实 JITI 加载测试也已通过。
- `ctx.ui.custom()` 的 `blocked` 选项、Markdown 渲染元数据、扩展 changelog 等都是新增可选能力，不使用不代表不兼容。
- pi-base 没有调用 `pi.exec()` 或监听 `before_provider_headers`，对应的输出上限和 attribution-header 变化没有直接改动点。
- MCP OAuth 注册流程由原生 Pi 管理，pi-base 的迁移脚本不写入这些 OAuth 注册策略。
- 修正了原有 4 个失败测试中的旧工具提示标题断言。它们在升级前也失败，不属于 Pi 1.5 回归。

## 验证记录与边界

| 环境 | 验证 | 结果 |
|---|---|---|
| Pi 1.5.0 / Node.js 22.23.4 / Linux | `npm run typecheck` | 通过 |
| 同上 | `npm test` | 82 个文件、1112 个用例全部通过，无跳过 |
| Pi 1.2.0 原 lockfile 的隔离副本 | `npm run typecheck` | 通过 |
| 同上 | 压缩、grep、Agent 工具策略、全工具 schema、Goal runtime、原生 MCP 与 JITI 委派的 8 个测试文件 | 66 个用例全部通过；不是 1.2 全量测试 |
| 工作树 | `git diff --check` | 通过 |

集成测试使用真实 Pi SDK 和本地 stdio MCP fixture，但模型流和鉴权凭据使用离线替身。没有执行真实供应商 OAuth 登录、远程模型请求、远程 MCP OAuth 登录或交互式终端目视验收；Windows/macOS 的真实系统行为也未在本次 Linux 环境实测。

检查和测试没有更改用户的 Pi 全局配置或凭据，也没有发布软件包。使用该本地扩展的交互会话需要 `/reload` 才会加载修改。

## Pi 1.5.1 复验

开发依赖及兼容性测试基线已从 `1.5.0` 升至 `1.5.1`，同步更新 lockfile、版本断言和中英文安装/开发说明。peer dependencies 保持 `^1.2.0`，没有引入新的运行时 API。基线升级后，另行复现并修复下文的自有搜索工具问题。

仓库原有 `node_modules` 实际残留 `1.2.0`，与声明的 `1.5.0` 不一致。本次通过 `npm ci` 重装，并用 `npm ls` 确认三个 Pi 开发依赖均为 `1.5.1`，没有 invalid 依赖。

| 环境 | 验证 | 结果 |
|---|---|---|
| Pi 1.5.1 / Node.js 24.14.0 / Linux | `npm run typecheck` | 通过 |
| 同上 | `npm test -- --reporter=dot` | 包含搜索工具修复及回归用例后，82 个文件、1130 个用例全部通过，无跳过 |

未发现已确认的 1.5.1 升级阻塞项。验证仍使用离线模型流和本地 MCP fixture，没有验证远程模型、代理兼容性、OAuth 登录或 Windows/macOS 的实际行为。

### 已复现并修复的搜索工具问题

以下是 pi-base 自有工具原本就有的问题，不是升级 1.5.1 导致的回归，也不会因升级宿主自动修复。每项均先用失败的回归用例确认，再改实现：

- **grep 路径 glob 基准**：真实 rg 14.1.0 下，进程启动目录不是搜索根时，路径 glob 会漏匹配；前导 `./` 和符号链接目录也会漏匹配。普通及多行搜索现在均以搜索目录为 `cwd`、搜索 `.`，规范化 glob 前导 `./` 并保留 `!` 否定。返回的相对路径及缺少行文本时的兜底读取也以搜索根解析。
- **find 结果上限**：真实 fd 10.2.0 将 `--max-results 0` 视为不限数量，并拒绝负数和小数。现在将小于 1 的 limit 钳制为 1、正小数向下取整；用 `limit + 1` 探测真正溢出，只输出 limit 条。恰好 limit 条时不再误报截断。
- **grep 精确上限与流式输出**：恰好 limit 个匹配事件时不再误报截断，只有收到下一条匹配才设置提示并终止进程。Review 时另用分批输出先复现提前终止导致漏报溢出，再移除第 N 条后的提前 kill；延迟到达的 lookahead 不会展示，进程在确认溢出后仍会停止。

红绿记录：grep 路径及精确上限的回归在修复前 9 失败、18 通过；find 回归在修复前 4 失败、7 通过；Review 补充的两条延迟 lookahead 用例在修正前均收到 `matchLimitReached: undefined` 而不是 `2`。修复后 grep 三个定向文件 34 用例通过，find 原生测试 11 用例通过，最终全量结果见上表。

本轮没有将内存优化当作已确认缺陷重构：read 仍有 64 MiB 大小保护；grep 没有 context 参数，正常使用 rg JSON 的行文本，仅在事件缺少行文本时回读整文件。该兜底缺少逐文件大小保护，但本轮未证实正常 rg 输出会触发此路径。

Anthropic message threads 不会使 `before_provider_request` 只收到增量消息：Pi 1.5.1 在调用 payload hook 后才执行 `prepareThreadRequest()` 裁剪消息，并在前缀比较时忽略消息内的 `cache_control`。因此没有发现缓存边界扩展与该 hook 顺序的不兼容；实际网关的 thread 支持仍需独立验证。
