import { getAgentDir, initTheme } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

initTheme("dark", false);
type MockUiOverrides = Partial<{
  notify: (message: string, variant: string) => void;
  setStatus: (key: string, text: string | undefined) => void;
  select: (title: string, items: string[]) => Promise<string | undefined> | string | undefined;
  confirm: (title: string, message: string) => Promise<boolean> | boolean;
  custom: (factory: any, options?: any) => Promise<any> | any;
}>;

function createTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
}

function truncateFooterLine(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 0) return "";
  if (width <= 3) return ".".repeat(width);
  return `${text.slice(0, width - 3)}...`;
}

function getDefaultSessionDir(cwd: string): string {
  const resolvedCwd = join(cwd).replace(/\\/g, "/");
  const safePath = `--${resolvedCwd.replace(/^\//, "").replace(/[/:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safePath);
}

export function createToolRegistry(options: { hasUI?: boolean; cwd?: string; ui?: MockUiOverrides; model?: any; models?: any[]; modelRegistry?: any } = {}) {
  if (process.env.PI_BASE_GLOBAL_SETTINGS_PATH === undefined) {
    process.env.PI_BASE_GLOBAL_SETTINGS_PATH = join(tmpdir(), "pi-base-test-global-settings.json");
  }
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, Function[]>();
  const entries: any[] = [];
  const notifications: Array<{ message: string; variant: string }> = [];
  const messages: any[] = [];
  const messageSends: Array<{ message: any; options: any }> = [];
  const messageRenderers = new Map<string, any>();
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, string[] | { render: (width: number) => string[]; dispose?: () => void }>();
  const flags = new Map<string, { type: "boolean" | "string"; default?: boolean | string }>();
  const flagValues = new Map<string, boolean | string>();
  let activeTools: string[] = [];
  let defaultHasUI = options.hasUI ?? true;
  let defaultCwd = options.cwd ?? process.cwd();
  let uiOverrides: MockUiOverrides = { ...(options.ui ?? {}) };
  let thinkingLevel = "off";
  let currentModel: any = undefined;
  const models = new Map<string, any>();
  let footerFactory: ((tui: any, theme: any, footerData: any) => any) | undefined;
  let footerComponent: any;
  const theme = createTheme();
  const tui = {
    requestRender() {},
  };
  const footerData = {
    getGitBranch() {
      return null;
    },
    getExtensionStatuses() {
      return new Map(statuses);
    },
    getAvailableProviderCount() {
      return 1;
    },
    onBranchChange() {
      return () => {};
    },
  };

  const registerModel = (model: any) => {
    if (!model?.provider || !model?.id) return;
    models.set(`${model.provider}/${model.id}`, model);
    if (!currentModel) {
      currentModel = model;
    }
  };

  for (const model of options.models ?? []) {
    registerModel(model);
  }
  if (options.model) {
    registerModel(options.model);
    currentModel = options.model;
  }

  const buildContext = (overrides: any = {}) => {
    const ui = {
      theme,
      notify(message: string, variant: string) {
        notifications.push({ message, variant });
        uiOverrides.notify?.(message, variant);
      },
      setStatus(key: string, text: string | undefined) {
        if (text === undefined) {
          statuses.delete(key);
        } else {
          statuses.set(key, text);
        }
        uiOverrides.setStatus?.(key, text);
      },
      async select(title: string, items: string[]) {
        if (uiOverrides.select) return uiOverrides.select(title, items);
        return items[0];
      },
      async confirm(title: string, message: string) {
        if (uiOverrides.confirm) return uiOverrides.confirm(title, message);
        return true;
      },
      setWidget(key: string, content: string[] | ((tui: any, theme: any) => { render: (width: number) => string[]; dispose?: () => void }) | undefined) {
        const existing = widgets.get(key);
        if (existing && !Array.isArray(existing)) existing.dispose?.();
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, typeof content === "function" ? content(tui, theme) : content);
      },
      setFooter(factory: any) {
        footerFactory = factory;
        footerComponent?.dispose?.();
        footerComponent = undefined;
      },
      async custom(factory: any, options?: any) {
        if (uiOverrides.custom) return uiOverrides.custom(factory, options);
        return undefined;
      },
      setTitle() {},
      setEditorText() {},
      getEditorText() {
        return "";
      },
      addAutocompleteProvider() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setToolsExpanded() {},
      getToolsExpanded() {
        return false;
      },
      setEditorComponent() {},
      getEditorComponent() {
        return undefined;
      },
      pasteToEditor() {},
      getAllThemes() {
        return [];
      },
      getTheme() {
        return undefined;
      },
      setTheme() {
        return { success: false, error: "unsupported" };
      },

    };
    const sessionManager = {
      getEntries() {
        return [...entries];
      },
      getSessionId() {
        return "test-session";
      },
      getBranch() {
        return [...entries];
      },
      getLeafId() {
        return null;
      },
      getLabel() {
        return undefined;
      },
      getCwd() {
        return defaultCwd;
      },
      getSessionDir() {
        return getDefaultSessionDir(defaultCwd);
      },
      getSessionFile() {
        return undefined;
      },
      getSessionName() {
        return undefined;
      },

    };
    const resolvedUi = overrides.ui ? { ...ui, ...overrides.ui } : ui;
    return {
      hasUI: overrides.hasUI ?? defaultHasUI,
      mode: overrides.mode ?? "tui",
      cwd: overrides.cwd ?? defaultCwd,
      sessionManager,
      modelRegistry: options.modelRegistry ?? {
        find(provider: string, modelId: string) {
          return models.get(`${provider}/${modelId}`);
        },
        isUsingOAuth: () => false,
      } as any,
      model: currentModel,
      isIdle: () => true,
      signal: overrides.signal,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
      waitForIdle: async () => undefined,
      reload: async () => undefined,
      ...overrides,
      ui: resolvedUi,
    };
  };

  const applyToolCallHandlers = async (toolName: string, toolCallId: string, input: any, ctx: any) => {
    const handlers = events.get("tool_call") ?? [];
    const current = {
      type: "tool_call",
      toolName,
      toolCallId,
      input,
    };
    for (const handler of handlers) {
      const result = await handler(current, ctx);
      if (result?.block) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.reason ?? `${toolName} blocked by tool_call handler.`}` }],
          isError: true,
        };
      }
    }
    return undefined;
  };

  const applyToolResultHandlers = async (toolName: string, toolCallId: string, input: any, result: any, ctx: any) => {
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
      const next = await handler(current, ctx);
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
            const eventContext = buildContext(ctx);
            const blocked = await applyToolCallHandlers(tool.name, toolCallId, params, eventContext);
            if (blocked) return blocked;
            const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
            return applyToolResultHandlers(tool.name, toolCallId, params, result, eventContext);
          },
        });
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
      registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string }) {
        flags.set(name, { type: options.type, default: options.default });
        if (options.default !== undefined && !flagValues.has(name)) {
          flagValues.set(name, options.default);
        }
      },
      getFlag(name: string) {
        if (!flags.has(name)) return undefined;
        return flagValues.get(name);
      },
      appendEntry(customType: string, data?: unknown) {
        entries.push({ type: "custom", customType, data });
      },
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
      getActiveTools() {
        return activeTools;
      },
      getAllTools() {
        return Array.from(tools.values());
      },
      getThinkingLevel() {
        return thinkingLevel;
      },
      setThinkingLevel(level: string) {
        thinkingLevel = level;
      },
      async setModel(model: any) {
        currentModel = model;
        registerModel(model);
        return true;
      },
      on(name: string, handler: Function) {
        const list = events.get(name) ?? [];
        list.push(handler);
        events.set(name, list);
      },
      registerMessageRenderer(customType: string, renderer: any) {
        messageRenderers.set(customType, renderer);
      },
      sendMessage(message: any, options?: any) {
        messages.push(message);
        messageSends.push({ message, options });
      }
    },
    getTool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool;
    },
    getCommand(name: string) {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      return command;
    },
    async runCommand(name: string, args = "", ctx: any = {}) {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      return command.handler(args, buildContext(ctx));
    },
    getActiveTools() {
      return activeTools;
    },
    getEntries() {
      return [...entries];
    },
    getStatuses() {
      return new Map(statuses);
    },
    getWidget(key: string, width = 200) {
      const widget = widgets.get(key);
      return widget && !Array.isArray(widget) ? widget.render(width) : widget;
    },
    getNotifications() {
      return [...notifications];
    },
    getMessages() {
      return [...messages];
    },
    getMessageSends() {
      return [...messageSends];
    },
    getMessageRenderer(customType: string) {
      return messageRenderers.get(customType);
    },
    setUI(overrides: MockUiOverrides) {
      uiOverrides = { ...uiOverrides, ...overrides };
    },
    setHasUI(next: boolean) {
      defaultHasUI = next;
    },
    setCwd(next: string) {
      defaultCwd = next;
    },
    setFlag(name: string, value: boolean | string) {
      flagValues.set(name, value);
    },
    setThinkingLevel(next: string) {
      thinkingLevel = next;
    },
    getCurrentModel() {
      return currentModel;
    },
    registerModel,
    renderFooter(width = 120) {
      if (footerFactory) {
        if (!footerComponent) {
          footerComponent = footerFactory(tui, theme, footerData);
        }
        return footerComponent.render(width);
      }

      const lines = [
        truncateFooterLine(defaultCwd, width),
        truncateFooterLine(`0.0%/0 (auto) ${currentModel ? `${currentModel.provider}/${currentModel.id}` : "no-model"}`, width),
      ];
      const extensionStatuses = Array.from(statuses.entries())
        .filter(([, text]) => text)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, text]) => text as string);
      if (extensionStatuses.length > 0) {
        lines.push(truncateFooterLine(extensionStatuses.join(" "), width));
      }
      return lines;
    },
    async emit(name: string, event: any, ctx: any = {}) {
      const handlers = events.get(name) ?? [];
      const eventContext = buildContext(ctx);
      if (name === "before_agent_start") {
        let currentEvent = { ...event };
        const messages: any[] = [];
        let systemPromptModified = false;
        for (const handler of handlers) {
          const result = await handler(currentEvent, eventContext);
          if (!result) continue;
          if (result.message !== undefined) messages.push(result.message);
          if (result.systemPrompt !== undefined) {
            currentEvent = { ...currentEvent, systemPrompt: result.systemPrompt };
            systemPromptModified = true;
          }
        }
        if (messages.length === 0 && !systemPromptModified) return undefined;
        return {
          ...(messages.length > 0 ? { messages } : {}),
          ...(systemPromptModified ? { systemPrompt: currentEvent.systemPrompt } : {}),
        };
      }
      if (name === "context") {
        let currentEvent = { ...event };
        let aggregate: any = undefined;
        for (const handler of handlers) {
          const result = await handler(currentEvent, eventContext);
          if (!result) continue;
          aggregate = { ...aggregate, ...result };
          if (result.messages !== undefined) {
            currentEvent = { ...currentEvent, messages: result.messages };
          }
        }
        return aggregate;
      }
      let current = undefined;
      for (const handler of handlers) {
        current = await handler(event, eventContext);
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
