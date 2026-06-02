import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createToolRegistry() {
  const tools = new Map<string, any>();
  const events = new Map<string, Function[]>();
  let activeTools: string[] = [];

  const applyToolResultHandlers = async (toolName: string, toolCallId: string, input: any, result: any) => {
    const handlers = events.get("tool_result") ?? [];
    let current = {
      type: "tool_result",
      toolName,
      toolCallId,
      input,
      content: result.content,
      details: result.details,
      isError: Boolean(result.isError),
    };
    for (const handler of handlers) {
      const next = await handler(current, {} as any);
      if (!next) continue;
      if (next.content !== undefined) current.content = next.content;
      if (next.details !== undefined) current.details = next.details;
      if (next.isError !== undefined) current.isError = next.isError;
    }
    return {
      ...result,
      content: current.content,
      details: current.details,
      ...(current.isError ? { isError: true } : {}),
    };
  };

  return {
    pi: {
      registerTool(tool: any) {
        const originalExecute = tool.execute?.bind(tool);
        tools.set(tool.name, {
          ...tool,
          async execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) {
            const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
            return applyToolResultHandlers(tool.name, toolCallId, params, result);
          },
        });
      },
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
      getActiveTools() {
        return activeTools;
      },
      on(name: string, handler: Function) {
        const list = events.get(name) ?? [];
        list.push(handler);
        events.set(name, list);
      },
    },
    getTool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool;
    },
    getActiveTools() {
      return activeTools;
    },
    async emit(name: string, event: any) {
      const handlers = events.get(name) ?? [];
      let current = undefined;
      for (const handler of handlers) {
        current = await handler(event, {} as any);
      }
      return current;
    },
  };
}

export async function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-base-"));
}

export async function writeWorkspaceFile(root: string, relativePath: string, content: string): Promise<string> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true }).catch(() => undefined);
  await mkdir(join(root, relativePath.split("/").slice(0, -1).join("/")), { recursive: true }).catch(() => undefined);
  await writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

export function getText(result: any): string {
  return result.content?.find((item: any) => item.type === "text")?.text ?? "";
}
