# pi-base Subagent 委派 — 详细技术方案

> 阶段：详细设计（实现范围、变更清单、模块/接口、entry schema、扩展加载策略、流程、UI、权限、取消/崩溃、坑位盘点、测试、上线、已定决策）。方向与核心原理见同目录 `high-level-design.md`。

## 1. 实现范围

- 仓库/扩展：`pi-base`（单扩展，`index.ts` 入口，ESM + vitest）。
- 新增：`src/subagent/` 模块 7 个文件。
- 改动既有：`src/agent-support.ts`、`src/index-impl.ts`。
- 依赖：仅用现有 peerDependency `@earendil-works/pi-coding-agent@^0.74`；**不新增运行时依赖**。
- 配置：`pi-base.json` 新增 `subagent.maxDepth`（默认 2）、`subagent.maxConcurrency`（默认 10）。
- agent 定义：frontmatter 新增可选 `subagents: string[]`。

## 2. 变更清单

| 类型 | 文件 | 内容 |
| --- | --- | --- |
| 新增 | `src/subagent/config.ts` | 读取并合并 `subagent.maxDepth`（默认 2）、`subagent.maxConcurrency`（默认 10） |
| 新增 | `src/subagent/depth.ts` | 读/写会话 `pi-base-subagent-depth` entry |
| 新增 | `src/subagent/registry.ts` | 进程级 `SubagentRegistry` 单例（EventEmitter） |
| 新增 | `src/subagent/runner.ts` | `spawnSubagent` / `resumeSubagent`：会话构造、订阅收敛、级联取消 |
| 新增 | `src/subagent/ui-bridge.ts` | 权限/交互 UI 桥（子→父，标注 agent） |
| 新增 | `src/subagent/task-tool.ts` | `task` 工具注册（schema/execute/render/返回体） |
| 新增 | `src/subagent/widget/tree.ts` | 状态树 widget（仅 depth==1 注册） |
| 新增 | `src/subagent/reconcile.ts` | resume 悬空 task 调用对账 |
| 改动 | `src/agent-support.ts` | 解析 `subagents`；`applyAgent` 按 depth+白名单注入/撤除 `task` |
| 改动 | `src/index-impl.ts` | 注册 `task`；修正退役 `task` 清理；接线 registry/widget/reconcile |
| 新增测试 | `tests/subagent-*.test.ts` | 见第 12 节 |
| 新增文档 | `docs/subagent/*.md` | 本方案 |

## 3. 实现步骤（建议顺序）

> 实施进度（截至当前）：增量 1、2、3 已完成并验证（`npm run typecheck` + 全量 `vitest` 511 测试通过，无回归）。增量 4（UI/恢复）待实现。

- [x] **增量 1（基础层）**：`config.ts`（新增 `subagent` 设置 sanitize/normalize/merge）、`subagent/config.ts`、`subagent/depth.ts`、`subagent/registry.ts`、`subagent/permission-host.ts`、`subagent/constants.ts`；单测 `tests/subagent-config.test.ts`、`tests/subagent-foundation.test.ts`。
- [x] **增量 2（agent 装配 + 权限接线）**：`agent-support.ts` 解析 `subagents` frontmatter + `applyAgent` 中 `applyTaskInjection`（按 `depth<maxDepth && subagents 非空` 双向增删 `task`）+ 返回 `AgentSupportHandle`；`permission.ts` 的 `!ctx.hasUI` 分支经 `resolveSubagentInfo`（仅 depth>1 的真子会话）relay 到宿主；`index-impl.ts` 修正退役 `task` 清理（仅当未注册自有 `task` 时清理）、root 会话注册权限宿主（含并发 mutex）、接线 `subagentControls`。
  - 备注：`applyTaskInjection` 的**正向注入**依赖 `task` 工具已注册（增量 3），故其端到端测试随增量 3 落地。
- [x] **增量 3（spawn 引擎）**：`subagent/runner.ts`（可注入 `createAgentSession` 工厂 + 真实工厂 `createRealSubagentFactory`）+ `subagent/task-tool.ts`（注册 `task`，schema=TypeBox）+ `subagent/schema.ts` + `index-impl.ts` 注册接线（含修正 session_start 使 `task` 不进默认 active 集，仅委派 agent 经注入获得）；单测 `tests/subagent-runner.test.ts`、`tests/subagent-task-tool.test.ts`、`tests/subagent-task-injection.test.ts`（spawn/resume/跨类型切换/并发上限/取消/报告收敛/depth+1/白名单/注入）。
  - 备注：真实工厂 `createRealSubagentFactory`（实际 `createAgentSession` 拉起子会话）仅在真实 pi 运行时可端到端验证；单测用 fake 工厂覆盖编排逻辑。
- [ ] **增量 4（UI + 恢复）**：`subagent/widget/tree.ts`（`setWidget(string[])`，仅 depth==1）、`subagent/reconcile.ts`（session_start 补 interrupted）、`/subagents` 只读面板（`ctx.ui.custom` + Component）。

原始建议顺序：
1. `config.ts` + `depth.ts`（纯函数，易测）。
2. `registry.ts`（内存态 + 事件，易测）。
3. `runner.ts` 的 `createAgentSession` 工厂**做成可注入**（测试替身），实现 spawn/resume/取消。
4. `task-tool.ts`：schema + execute（先不接 UI），返回体与报告收敛。
5. `agent-support.ts` / `index-impl.ts` 接线：注入/撤除 `task`、修正退役清理。
6. `ui-bridge.ts` + `widget/tree.ts`：权限桥与状态树。
7. `reconcile.ts`：崩溃对账。
8. 补齐测试、typecheck、`vitest run`。

## 4. 模块级设计

### 4.1 config.ts

- `getMaxDepth(cwd): number`：复用 pi-base 现有配置合并（`loadRuntimePiBaseSettings` 同源），读 `subagent.maxDepth`，缺省 `2`，下限钳制为 `1`。
- `getMaxConcurrency(cwd): number`：读 `subagent.maxConcurrency`，缺省 `10`，下限钳制为 `1`。

### 4.2 depth.ts

- `readDepth(ctx): number`：扫 `ctx.sessionManager.getEntries()`，取最后一条 `type==="custom" && customType===DEPTH_ENTRY` 的 `depth`；无则 `1`。
- `writeDepth(sm, depth)`：`sm.appendCustomEntry(DEPTH_ENTRY, { depth })`。
- 常量 `DEPTH_ENTRY = "pi-base-subagent-depth"`。

### 4.3 registry.ts（进程级单例）

```ts
class SubagentRegistry extends EventEmitter {
  private nodes = new Map<string, SubagentNode>();
  upsert(node: SubagentNode): void;                 // emit("change")
  update(id: string, patch: Partial<SubagentNode>): void;
  get(id: string): SubagentNode | undefined;
  children(parentId: string): SubagentNode[];
  running(): SubagentNode[];
  attachSession(id: string, session: AgentSession): void; // 供 cancel 用（弱引用/结束即移除）
  prune(id: string, afterMs?: number): void;        // 完成节点延迟移除
}
export const registry = /* module-level singleton */;
```

- 单例经模块缓存跨会话共享（同进程同一 pi-base 模块实例）。
- **不持久化**；进程退出即消失。

### 4.4 runner.ts

```ts
interface SpawnArgs { ctx; agentType; description; prompt; }
interface RunResult { sessionId; state: "completed"|"error"|"cancelled"; report?; error?; }

async function spawnSubagent(a: SpawnArgs, onUpdate): Promise<RunResult>;
async function resumeSubagent(ctx, sessionId, prompt, onUpdate): Promise<RunResult>;
```

要点：
- `createAgentSession` 通过**可注入工厂**调用（默认真实实现，测试可替身）。
- **持久化到隔离目录**（见第 6.1 节）：`SessionManager.create(cwd, subagentSessionDir(cwd), { parentSession: 父会话文件 })`；新建时预写 `pi-base-agent-state`/`pi-base-subagent-depth` 两条 custom entry（见第 7 节）。
- 受控 `resourceLoader`（见第 6 节）；`modelRegistry: ctx.modelRegistry`；`model` 初始传 `ctx.model`（子会话 agent-support 会在 `before_agent_start` 按 agent 定义 `setModel` 切换到最新配置，见 5.1）；`cwd/agentDir` 透传。
- `session.bindExtensions({ uiContext: 权限桥, mode: "interactive" })`——**注入 mode=interactive**，否则某些 UI 行为按 print 模式退化（`runner.setUIContext(uiContext, mode)`，`runner.ts:400`）。
- `session.subscribe`：累加 `toolCount`、把动作压成活动行经 `onUpdate` 推出（节流，见坑位 P14）。
- 报告收敛：`await session.prompt()` 返回后，取 `session.messages` 最后一条 assistant 文本；为空则回退状态说明。（subscribe 只用于实时活动/计数，不用于最终报告。）
- 运行失控兜底（P30）：subscribe 计 turn 数，超过 `subagent.maxTurns`（可选配置，默认较大值）或超时则 `session.abort()` 收敛为 `error`，避免子会话不自然终止导致 `prompt()` 永不 resolve。
- `forwardAbortSignal(session, ctx.signal)`（= `signal.addEventListener("abort", () => session.abort())`）；`finally` 释放订阅、`registry.prune`。

### 4.5 ui-bridge.ts

- `createPermissionBridge(parentUi, label): ExtensionUIContext`：
  - 转发：`select` / `confirm` / `input` / `notify` / `theme`（前置 `⟳ subagent「{agentType}」(depth {d}) 申请：` 到标题/首行）。
  - no-op：`setStatus` / `setWidget` / `setFooter` / `setHeader` / `setTitle` / `custom` / working 指示等（子会话不得绘制主面板 chrome）。
  - 桥内维护一把**互斥锁**，串行化并发子会话的弹窗（坑位 P17）。

### 4.6 task-tool.ts

- `pi.registerTool({ name:"task", executionMode:"parallel", parameters, execute, renderCall, renderResult })`。
- `execute(id, params, signal, onUpdate, ctx)`：分派 spawn/resume；把 `onUpdate` 传下用于流式；返回体见第 5 节。
- `renderCall`：执行中用 `StreamingCallWindowComponent`/尾部折叠展示活动日志。
- `renderResult`：完成展示报告（可 `ctrl+o` 展开）；`interrupted` 静态渲染。

### 4.7 widget/tree.ts

- 仅当 `readDepth(ctx)===1`（root 会话）时渲染 widget。
- `ctx.ui.setWidget(key, lines: string[], options?)` 接收**行数组**（`extensions/types.ts:163`），非订阅式组件：订阅 `registry` 的 `change` 事件 → 按 `parentSessionId` 组树重算 `string[]` → 再次 `setWidget`（节流，P14）。
- 全部结束后收敛为一行摘要或 `setWidget(key, undefined)` 移除。

### 4.8 reconcile.ts

- `reconcileInterruptedTasks(ctx)`：`session_start` 时扫描本会话，找 `task` 的 `tool_use` 无配对 `tool_result` 者，补 `interrupted` 结果；幂等（已补过不重复）。

## 5. task 工具契约

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `subagent_type` | string | 是 | 必须 ∈ 当前 agent `subagents` 白名单 |
| `description` | string | 是 | 3-5 词短描述（UI 用） |
| `prompt` | string | 是 | 交给 subagent 的完整任务 |
| `session_id` | string | 否 | 传入则 resume 对应子会话；见下方 resume 行为 |

返回（进入模型上下文的**仅**此字符串）：

```xml
<task id="{sessionId}" state="completed">
<task_result>{最后一条 assistant 文本}</task_result>
</task>

<task id="{sessionId}" state="error"><task_error>{原因}</task_error></task>
<task id="{sessionId}" state="cancelled"><task_error>已取消</task_error></task>
<task id="{sessionId}" state="interrupted"><task_error>主进程中断，未完成</task_error></task>
```

- 任何状态都带 `id`，供复查/resume。
- 报告过长的截断策略见坑位 P12。

### 5.1 单工具 + resume 行为（含跨类型切换）

**决策：单 `task` 工具**（不做 `task_resume` 双工具），`subagent_type` 恒必填，`session_id` 可选。

- 新建（无 `session_id`）：按 spawn 流程。
- resume（有 `session_id`）：校验 `subagent_type ∈ 父 agent.subagents` → `SessionManager.open(path)` → **若传入的 `subagent_type` 与该会话当前 agent 不同，则追加一条新的 `pi-base-agent-state{name}`**，`bindExtensions` 后 `session_start` 的 `pickAgentFromEntries` 取最后一条 = 新类型 → `applyAgent` **重新读盘 `agents/X.md`（最新配置）** 并 `setModel`/`setActiveTools`/重建 system prompt → `session.prompt(prompt)`。
- 因此"用不同 `subagent_type` resume"= 对子会话做一次 agent 切换，模型+提示词+工具按最新配置生效；`depth` 不变；仍受父白名单约束。语义等价于会话内 `/agent` 切换（pi-base 已支持），无额外机制。
- 并发上限：单会话同时运行的 subagent 数受 `subagent.maxConcurrency`（默认 10）限制，超出的 `task` 调用返回 `error` 提示降低并行度（见 P27）。

## 6. 子会话扩展加载策略（关键）

`createAgentSession` 若不传 `resourceLoader` 会**加载该 cwd 全部扩展并 `reload()`**（`sdk.ts:180-184`），会导致每个 subagent 重启 MCP/LSP，开销与副作用不可接受。策略：

- 构造受控 `DefaultResourceLoader`，用 `extensionsOverride` **只保留 pi-base**（后续可扩展为 + agent 声明的 `extensions`），排除其余。
- 明确记录约束：**被排除扩展的 factory 仍会运行一次**（pi-subagents 注释：exclusion 只抑制 handler 绑定与工具注册，非沙箱）。因此 MCP/LSP 若在 factory 阶段就启动进程仍会触发——需在实现时验证 pi-base MCP/LSP 的启动时机（session_start vs factory），必要时用 `noExtensions`/更强隔离。
- **不要关闭 skills**（P31）：agent-support 在 `before_agent_start` 按 agent 定义注入 skills，其来源依赖 loader 已加载的 skills；若设 `noSkills`，声明了 `skills` 的 subagent 会拿不到技能而行为漂移。`noThemes`/`noContextFiles`/`noPromptTemplates` 可视需要关闭以降开销，skills 保持开启。

## 6.1 会话存储位置（隔离，避免污染 resume）

**决策：子会话不落默认 `sessions/` 目录，改落兄弟根目录 `subagent-sessions/`。**

```
<agentDir>/subagent-sessions/--<encoded-cwd>--/{timestamp}_{sessionId}.jsonl
```

- 复用 pi-base 现有编码约定（对照 `src/resume-all.ts:27-32` 的 `getDefaultSessionDirPath`），仅把路径段 `sessions` 换为 `subagent-sessions`：

  ```ts
  function subagentSessionDir(cwd: string): string {
    const resolvedCwd = resolve(cwd);
    const resolvedAgentDir = resolve(getAgentDir());
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(resolvedAgentDir, "subagent-sessions", safePath);
  }
  ```

- 隔离依据（已核验 pi 源码）：
  - `SessionManager.listAll()` 只遍历 `getSessionsDir()`（`<agentDir>/sessions/`）下目录（`session-manager.ts:1531-1547`）；`list(cwd)` 只扫 `<agentDir>/sessions/--cwd--/`（`1501-1510`）。`subagent-sessions/` 二者都不触及。
  - `listSessionsFromDir` 扁平、仅 `.jsonl`、非递归（`713-726`）；即便未来误用子目录方案也仅靠此保证，兄弟根目录更稳。
  - 同时避免污染"最近会话/自动续接"（其基于默认 `sessions/`）。
- 所有深度的子会话都按 `cwd` 计算写入同一 `subagent-sessions/--cwd--/`（不按当前会话目录计算，避免 `subagents/subagents` 嵌套），便于统一枚举与清理。
- `parentSession` 存父会话绝对路径，可跨目录指向 `sessions/` 主会话，不受影响。
- 我们自己的 resume：`SessionManager.list(cwd, subagentSessionDir(cwd))` 解析 `session_id → path`（显式 dir 触发 cwd 匹配过滤，子会话 cwd 一致正常命中），或直接按 `*_{id}.jsonl` 定位。
- 代价：子会话不出现在常规 `/resume`/`/resume-all`；人工续跑仅经 `task(session_id=...)`；人工浏览由只读面板 `/subagents` 提供（见第 15 节）。

## 7. session entry schema

| customType | data | 写入时机 | 读取方 |
| --- | --- | --- | --- |
| `pi-base-agent-state` | `{ name: string }` | 子会话创建时预写（复用既有常量） | `agent-support` `pickAgentFromEntries` |
| `pi-base-subagent-depth` | `{ depth: number }` | 子会话创建时预写 | `depth.readDepth` |

两者均为 `custom` entry，`buildSessionContext` 忽略、不进 LLM 上下文。

## 8. UI 实现细节

### 8.1 状态树（Block 1）

```
● Subagents  2 running · 1 done         (maxDepth 2)
main
├─ ⠹ planner   Draft migration plan     · 3 tools · 18s
├─ ⠹ explore   Scan schema usages       · 5 tools · 6s
└─ ✓ worker    Apply config patch        · sid:d4e5f6 · 41s
```

（默认 `maxDepth=2` 时 depth 2 即叶子；`maxDepth` 调大时 widget 会按 `parentSessionId` 展示更深层级。）

- 事件驱动重渲染（registry `change`），不轮询、不扫盘。
- 图标：`⠹` running / `✓` done / `✗` error / `■` cancelled|interrupted。

### 8.2 调用滚动容器（Block 2）—— 尾部向下滚动

```
task(planner) Draft migration plan                       ⠹ 22s
  ... (12 earlier lines, ctrl+o to expand)
  → grep  "ALTER TABLE"
  → bash  npm run db:plan
  → assistant 正在产出方案…
```

- 复用 bash 尾部折叠语义（`slice(-collapsedLines)`，顶部 `... earlier lines`），新行在底部追加。
- 完成后容器内容切为最终报告（`renderResult`，可展开）。
- **agent 仅接收最终报告**；活动日志只用于渲染，不进上下文、不落盘。

## 9. 权限设计

- 默认注入权限 UI 桥 → 子会话 `hasUI=true` → `permission.ts` 的 `ask` 弹主面板；桥标注申请 agent。**不改 permission.ts 判定逻辑**。
- 规则/yolo：子会话同 cwd，`loadRuntimePiBaseSettings` 每次 `tool_call` 实时读取，与主一致。
- 非交互场景（顶层 `hasUI=false`，如 print/CI/RPC）：桥无处可弹 → 子会话 `ask` 按现状 `block`（安全降级），仅 allow/yolo 的操作可执行。
- 嵌套：depth3 桥基于 depth2 桥透传，最终抵达真实 TUI。

## 10. 取消 / 异常 / 崩溃

- 取消：父 turn abort → `ctx.signal` → `session.abort()`，逐层级联；registry 置 `cancelled`，清订阅与 widget 行。
- 子会话内部异常：`execute` catch → 返回 `error`，不冒泡打断父 turn。
- 崩溃恢复：无孤儿进程（同进程）；`isStreamingCall` 恢复态为 false → 无转圈僵尸；registry/widget 纯内存 → 重启即空；`reconcile.ts` 在 `session_start` 补 `interrupted` 结果闭合对话。
- 悬空 tool_result 补齐层级待验证：若 pi-ai 已对 orphan tool_use 兜底，则只需渲染成 interrupted；否则 `reconcile` 负责补齐（第 12 节含测试）。

## 11. 风险与坑位盘点（深度）

> 分类列出实现前必须心里有数的疏漏点与缓解。标注 [阻塞] 者必须在编码期验证/处理。

### 子会话运行时
- P1 [阻塞] 子会话必须加载 pi-base，否则无 `task`/权限/depth。→ 受控 loader 强制保留 pi-base。
- P2 [阻塞] 默认 loader 会重启 MCP/LSP（每个 subagent 一次）。→ `extensionsOverride` 排除；验证 factory 副作用（第 6 节）。
- P3 被排除扩展 factory 仍跑一次（非沙箱）。→ 文档明示；重副作用扩展需 `noExtensions` 级隔离。
- P4 model/auth 未透传导致子会话无法鉴权。→ 传 `ctx.modelRegistry`，model 回退 `ctx.model`。
- P5 `parentSession` 是否污染上下文。→ 已验证 `buildSessionContext` 只读自身 entry，不污染。
- P6 同 cwd 并发编辑冲突。→ pi 的 `withFileMutationQueue` 按路径进程级串行（`read-core.ts:164`）缓解写冲突；语义冲突仍需 agent 自律，文档提示。

### 深度与工具注入
- P7 [阻塞] `task` 注入是双向的：canDelegate 时确保存在，达 maxDepth 时确保移除（agent 若未在 `tools` 列 task 也要能注入；若 `tools` 未定义=全量则要能撤除）。
- P8 off-by-one：`depth<maxDepth` 才注入（maxDepth=2 → depth 1 有 task、depth 2 无；default 2 即只允许一层委派）。
- P9 root 无 depth entry → 默认 1；resume 主会话仍为 1。

### task 契约与并发
- P10 [阻塞] `executionMode` 必须为 `parallel`，否则多 subagent 退化为串行。
- P11 子会话无最终 assistant 文本（以工具调用结尾/被中止）→ 报告回退为状态说明。
- P12 报告过长撑爆父上下文 → 设上限（如 N 字符）并提示"完整见 session_id resume"。
- P13 resume 并发重入：同一 session_id 正 running 时再 resume → registry 判定拒绝。

### UI
- P14 `onUpdate` 高频重渲染 → 节流（如 ≥100ms 或按事件类型）。
- P15 仅 depth==1 注册 widget，避免子会话（经桥 hasUI=true）误画主面板。
- P16 子会话经桥 hasUI=true 后，其 `setStatus/setFooter` 等必须在桥内 no-op。

### 权限
- P17 [阻塞] 跨会话并发弹窗冲突 → 桥内互斥串行；同 turn 兄弟 task 因权限预检顺序化天然不同时弹。
- P18 非交互顶层无 UI → 子会话 ask 安全 block（不可静默放行）。

### 崩溃/取消
- P19 [阻塞] 崩溃遗留悬空 task_use → `reconcile` 补 interrupted，避免对话结构非法/僵尸渲染；幂等。
- P20 取消/结束务必释放 `session.subscribe` 订阅与 registry attach，防泄漏。
- P21 磁盘遗留未完成子会话文件：无害，但可选清理/标记。

### 存储/配置/agent
- P22 [已定] 子会话存储隔离到兄弟根目录 `subagent-sessions/`（见 6.1），`list(cwd)`/`listAll()` 均不扫描，天然不污染 `/resume`；会话命名含 agent+description 便于辨识。
- P23 `subagents` 名解析失败 → 加载 warning + 剔除（复用现有 diagnostics）。
- P24 `task` 命名与退役清理冲突（`index-impl.ts:187-190`）→ 改为"只清非本扩展注册的历史 task"或移除该守卫。

### 工程/可测
- P25 [阻塞] `createAgentSession` 须经可注入工厂，便于单测替身（不打真实 LLM）。
- P26 模块单例假设：child 与 parent 须是同一 pi-base 模块实例（同解析路径），否则 registry 不共享。→ 受控 loader 用同一扩展路径保证。
- P27 [已定] 单层并发 fan-out 上限 `subagent.maxConcurrency`（默认 10）：单会话同时运行的 subagent 达上限后，超出的 `task` 调用返回 `error` 提示降低并行度（在 `task-tool.ts`/`registry` 计数处校验）；配合 maxDepth 兜底防 token/资源爆炸。
- P28 成本可见性：subagent token 不在父可见，仅报告可见。→ 文档提示；可选在 widget 显示 token（增强）。

### 子会话钩子与 hasUI 交互（本轮审计新增，已核验 pi 源码）
- [已核验] 子会话钩子会触发：`bindExtensions` 在 `agent-session.ts:2103` emit `session_start`；`before_agent_start`（1110）、`tool_call`/`tool_result`（417-442）在 turn 内触发。故子会话里 pi-base 的「agent 装配 / 权限守卫 / task 注入 / depth 读取」均正常工作；`bindExtensions({uiContext})` 在 2083-2085 接线子会话 ctx.ui。
- P29 [阻塞] 注入桥后子会话 `hasUI=true`，会激活 pi-base 中所有 `if(ctx.hasUI)` 分支。→ 审计 pi-base 全部 `ctx.hasUI`/`ctx.ui.*`/session_start 的主面板副作用（banner/footer/status/notify/message-renderer 注册等），凡"绘制主面板"者一律按 `depth===1` 门控；桥对非对话类 UI 一律 no-op（扩展 P15/P16）。
- P30 [阻塞] 子会话不自然终止（持续调工具）会使 `await session.prompt()` 永不 resolve。→ subscribe 计 turn/超时，达 `subagent.maxTurns`（可选配置）或超时 `session.abort()` 收敛为 `error`。
- P31 [阻塞] 不可对子会话 loader 设 `noSkills`：agent-support 注入的 skills 依赖 loader 已加载 skills，关闭会使声明 skills 的 subagent 行为漂移（见第 6 节）。
- P32 取消正阻塞在权限弹窗（经桥 `ui.select`）的子会话：`session.abort()` 需能取消该挂起对话。→ 桥监听 abort，reject/关闭挂起的 select。
- P33 API 形态差异：状态树 widget 用 `setWidget(key, string[])`（change 时重推、节流）；`/subagents` 只读面板用 `ctx.ui.custom` 返回 `Component`（render/handleInput）。两者不同 API，勿混用。
- P34 [待实现期确认] 孤儿 `tool_use`（崩溃遗留）未见 pi 自动修复逻辑 → `reconcile.ts` 为我方必备安全网（P19）；实现期确认 pi-ai 是否在发送前兜底，据此决定"补齐 + 渲染"还是"仅渲染"。

## 12. 测试与验收

| 用例 | 验证点 | 对应需求/坑位 |
| --- | --- | --- |
| depth 读写 | 无 entry→1；写后读回；resume 恢复 | R4/P8/P9 |
| maxDepth 注入 | depth<max 有 task、==max 无 task；双向增删 | R4/P7 |
| 白名单校验 | 非白名单 subagent_type 报错 | R3 |
| spawn（替身） | 返回真实 id + 报告；registry running→done | R6/R7/P25 |
| 并行委派 | 一 turn 两 task 并发、各自返回 | R5/P10 |
| resume（替身） | open+prompt 续跑；running 时拒绝重入 | R8/P13 |
| resume 跨类型切换 | 传不同 `subagent_type` resume → 追加 agent-state、应用最新 model/prompt/tools | 5.1 |
| 并发上限 | 单会话运行数达 `maxConcurrency` 后超出的 task 返回 error | P27 |
| 报告收敛 | 无 assistant 文本时回退；超长截断 | P11/P12 |
| 取消级联 | signal abort → session.abort；订阅释放 | R13/P20 |
| 崩溃对账 | 造悬空 task_use，reconcile 补 interrupted 且幂等 | R13/P19 |
| 权限桥 | 子 ask 转发父 ui.select 且含 agent 标注；no-op 项不触达主面板 | R12/P16 |
| 权限降级 | 顶层 hasUI=false 时子 ask 被 block | P18 |
| 退役清理 | 修正后 `task` 不被误删 | P24 |
| depth==1 门控 | 子会话（depth>1）不注册 widget、不绘制主面板 chrome | P15/P16/P29 |
| 失控兜底 | 子会话持续调工具达 maxTurns/超时 → abort 收敛 error | P30 |
| 渲染 | 执行中尾部滚动；恢复态静态无 spinner | R11 |

- 命令：`npm run typecheck` + `npm run test`（vitest）。参考既有 `tests/agent-support.test.ts`、`resume-all.test.ts`、`permission.test.ts`、`render.test.ts` 的替身与断言风格。

## 13. 上线与回滚

- 特性开关：`subagant` 能力可由"是否有 agent 配置了非空 `subagents`"自然启用；未配置则 `task` 从不注入，对现有行为零影响。
- 兼容：未使用 subagent 的会话行为完全不变；退役 task 清理修正需回归验证。
- 灰度：先在个人 agent 配置里开 1-2 个 `subagents` 试用。
- 回滚：移除 `task` 注入接线即可（模块可保留），无存储迁移。

## 14. 已定决策（原开放项，已拍板）

1. **工具命名**：单 `task` 工具（并修正退役 task 清理），不做 `task_resume`；resume 支持跨类型切换（见 5.1）。
2. **交互模式**：本期只做前台同步（`task` 调用 await 到子会话完成并返回报告）；后台异步/回灌列后续。
3. **存储位置**：已定兄弟根目录 `<agentDir>/subagent-sessions/--<cwd>--/`（见 6.1）。
4. **白名单**：`subagents` 为空 = 不能委派、不注入 task。
5. **并发上限**：`subagent.maxConcurrency` 默认 10；`subagent.maxDepth` 默认 2。

## 15. 增强项：`/subagents` 只读浏览面板

> 后续增强（非本期核心链路）。定位：浏览隔离目录里的 subagent 会话历史，**只读查看，不人工续跑**（续跑仍走 `task(session_id=...)`）。**已定：用稳定的 in-TUI overlay 面板，放弃外部编辑器**（`$EDITOR` 需挂起/恢复 TUI，不稳定）。

### 15.1 浏览（list）

- `SessionManager.list(cwd, subagentSessionDir(cwd))` 枚举子会话（见 6.1）。
- label = `agent · description · status · time · sid`，用 `ctx.ui.select(...)`（或 `SessionSelectorComponent` 风格）选择一个。

### 15.2 查看（稳定面板）

- 选中后：把该会话 entries 序列化为可读文本行（transcript），用 `ctx.ui.custom<void>(factory, { overlay: true, overlayOptions })`（`extensions/types.ts:189-203`）打开一个**只读滚动面板**。
- 面板组件（KISS，~80 行）：实现 custom 工厂要求的 `Component`（`render(width): string[]` + `handleInput(data)`），维护 scroll offset，按可视高度窗口化渲染；键位 ↑/↓ 行滚、PgUp/PgDn、g/G 顶/底、q|Esc 关闭（`done()`）。参考 `SessionSelectorComponent`/`select-list` 的键盘与滚动处理，复用同一 overlay 基础设施（已验证稳定）。
- 只读：不接收编辑、不返回值、不改会话。
- 样式：纯文本行即可（transcript 用 markdown 语法作为可读文本）；如需着色可选 `getMarkdownTheme()`（SDK 已导出），`Markdown` 组件未从 SDK 顶层导出，不作依赖。

### 15.3 transcript 序列化（session entries → text）

- 纯函数 `renderTranscript(entries): string[]`，易单测。
- header：agent、description、sid、model、起止时间、最终状态。
- 逐条：user/assistant 文本；`tool_use` 渲染为 `→ tool(args 摘要)`；`tool_result` 折叠显示（复用尾部/头部折叠约定）。
- 忽略或折叠 custom entry（agent-state/depth）。

### 15.4 取舍

- 放弃外部编辑器：`$EDITOR` 挂起 TUI 不稳定；in-TUI overlay 稳定且零外部依赖、最 KISS。
- transcript 只在面板内展示，**不落临时文件**；将来若需"导出 md 文件"再单独加。
