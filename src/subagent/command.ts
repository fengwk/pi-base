import {
  keyHint,
  rawKeyHint,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingsManager,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { isRootSession, readRootSessionId } from "./depth.js";
import { subagentRegistry, type SubagentNode } from "./registry.js";
import { getLiveSubagentView, getPersistedSubagentView, type SubagentViewSource } from "./runner.js";
import { SubagentSessionPanel, type SubagentViewportKeybindings } from "./session-panel.js";

const OVERLAY_VERTICAL_MARGIN = 1;
const FULLSCREEN_VIEWPORT_KEYBINDINGS = [
  "tui.altScreen.pageUp",
  "tui.altScreen.pageDown",
  "tui.altScreen.halfPageUp",
  "tui.altScreen.halfPageDown",
  "tui.altScreen.top",
  "tui.altScreen.bottom",
] as const;
const EMPTY_VIEWPORT_KEYBINDINGS: SubagentViewportKeybindings = {
  pageUp: [],
  pageDown: [],
  halfPageUp: [],
  halfPageDown: [],
  top: [],
  bottom: [],
};

interface DisposableComponent extends Component {
  dispose?: () => void;
}

interface SubagentPanelTarget {
  sessionId: string;
  source: SubagentViewSource;
  live: boolean;
  getNode: () => SubagentNode | undefined;
}

function formatChoice(node: SubagentNode): string {
  const activity = node.lastActivity ? ` · ${node.lastActivity}` : "";
  return `${node.agentType} · ${node.status} · turns: ${node.turns} · tool calls: ${node.toolCount} · ${node.sessionId}${activity}`;
}

function resolveRequestedNode(nodes: SubagentNode[], query: string): SubagentNode | "ambiguous" | undefined {
  const exact = nodes.find((node) => node.sessionId === query);
  if (exact) return exact;
  const prefixed = nodes.filter((node) => node.sessionId.startsWith(query));
  if (prefixed.length === 0) return undefined;
  return prefixed.length === 1 ? prefixed[0] : "ambiguous";
}

function createLiveTarget(node: SubagentNode): SubagentPanelTarget | undefined {
  const source = getLiveSubagentView(node.sessionId);
  if (!source) return undefined;
  return {
    sessionId: node.sessionId,
    source,
    live: true,
    getNode: () => subagentRegistry.get(node.sessionId),
  };
}

function resolveSubagentTarget(
  cwd: string,
  nodes: SubagentNode[],
  query: string,
): SubagentPanelTarget | "ambiguous" | undefined {
  const liveNode = resolveRequestedNode(nodes, query);
  if (liveNode === "ambiguous") return "ambiguous";
  if (liveNode) {
    const liveTarget = createLiveTarget(liveNode);
    if (liveTarget) return liveTarget;
  }

  const persisted = getPersistedSubagentView(cwd, liveNode?.sessionId ?? query);
  if (!persisted || persisted === "ambiguous") return persisted;
  return {
    sessionId: persisted.sessionId,
    source: persisted.source,
    live: false,
    getNode: () => subagentRegistry.get(persisted.sessionId),
  };
}

function padToWidth(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "…");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function disableFullscreenViewportBindings(keybindings: KeybindingsManager): () => void {
  // TuiAltScreen consumes these keys before the focused overlay sees them; scope the
  // override to this component so the user's normal fullscreen navigation is restored on close.
  const original = keybindings.getUserBindings();
  const scoped = { ...original };
  for (const binding of FULLSCREEN_VIEWPORT_KEYBINDINGS) scoped[binding] = [];
  keybindings.setUserBindings(scoped);

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    const current = keybindings.getUserBindings();
    const next = { ...current };
    for (const binding of FULLSCREEN_VIEWPORT_KEYBINDINGS) {
      const currentKeys = current[binding];
      if (!Array.isArray(currentKeys) || currentKeys.length !== 0) continue;
      if (Object.hasOwn(original, binding)) next[binding] = original[binding];
      else delete next[binding];
    }
    keybindings.setUserBindings(next);
  };
}

function captureFullscreenViewportBindings(keybindings: KeybindingsManager): SubagentViewportKeybindings {
  return {
    pageUp: keybindings.getKeys("tui.altScreen.pageUp"),
    pageDown: keybindings.getKeys("tui.altScreen.pageDown"),
    halfPageUp: keybindings.getKeys("tui.altScreen.halfPageUp"),
    halfPageDown: keybindings.getKeys("tui.altScreen.halfPageDown"),
    top: keybindings.getKeys("tui.altScreen.top"),
    bottom: keybindings.getKeys("tui.altScreen.bottom"),
  };
}

class SubagentSelector implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly nodes: SubagentNode[];
  private readonly onSelect: (node: SubagentNode) => void;
  private readonly onCancel: () => void;
  private selectedIndex = 0;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    nodes: SubagentNode[];
    onSelect: (node: SubagentNode) => void;
    onCancel: () => void;
  }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.nodes = options.nodes;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.selectedIndex = Math.min(this.nodes.length - 1, this.selectedIndex + 1);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
      const selected = this.nodes[this.selectedIndex];
      if (selected) this.onSelect(selected);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) this.onCancel();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const border = this.theme.fg("borderAccent", "─".repeat(safeWidth));
    const title = padToWidth(` ${this.theme.fg("accent", "View subagent")}`, safeWidth);
    const choices = this.nodes.map((node, index) => {
      const selected = index === this.selectedIndex;
      const prefix = selected ? "→ " : "  ";
      const currentNode = subagentRegistry.get(node.sessionId) ?? node;
      const label = truncateToWidth(formatChoice(currentNode), Math.max(1, safeWidth - 3), "…");
      const color = selected ? "accent" : "text";
      return padToWidth(` ${this.theme.fg(color, prefix + label)}`, safeWidth);
    });
    const footer = padToWidth(
      ` ${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`,
      safeWidth,
    );
    const empty = " ".repeat(safeWidth);
    return [border, empty, title, empty, ...choices, empty, footer, empty, border];
  }

  invalidate(): void {}
}

class SubagentCommandOverlay implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly cwd: string;
  private readonly done: () => void;
  private readonly notifyUnavailable: (sessionId: string) => void;
  private readonly nodes: SubagentNode[];
  private readonly viewportKeybindings: SubagentViewportKeybindings;
  private readonly restoreFullscreenViewportBindings: () => void;
  private current: DisposableComponent;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private disposed = false;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    cwd: string;
    done: () => void;
    nodes: SubagentNode[];
    initialTarget?: SubagentPanelTarget;
    notifyUnavailable: (sessionId: string) => void;
  }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.cwd = options.cwd;
    this.done = options.done;
    this.notifyUnavailable = options.notifyUnavailable;
    this.nodes = options.nodes;
    const fullscreen = this.tui.mode === "fullscreen";
    this.viewportKeybindings = fullscreen
      ? captureFullscreenViewportBindings(this.keybindings)
      : EMPTY_VIEWPORT_KEYBINDINGS;
    this.restoreFullscreenViewportBindings = fullscreen
      ? disableFullscreenViewportBindings(this.keybindings)
      : () => undefined;
    try {
      this.current = options.initialTarget ? this.createSessionPanel(options.initialTarget) : this.createSelector();
    } catch (error) {
      this.restoreFullscreenViewportBindings();
      throw error;
    }
  }

  private requestClose(): void {
    if (this.closing || this.disposed) return;
    this.closing = true;
    if (this.closeTimer !== undefined) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    try {
      this.done();
    } finally {
      this.restoreFullscreenViewportBindings();
    }
  }

  private scheduleClose(): void {
    if (this.closeTimer !== undefined) return;
    // showExtensionCustom stores the component in a promise continuation; defer past that
    // continuation so its close path can dispose this overlay.
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      this.requestClose();
    }, 0);
  }

  private createSelector(): SubagentSelector {
    return new SubagentSelector({
      tui: this.tui,
      theme: this.theme,
      keybindings: this.keybindings,
      nodes: this.nodes,
      onSelect: (node) => this.showSession(node),
      onCancel: () => this.requestClose(),
    });
  }

  private createSessionPanel(target: SubagentPanelTarget): DisposableComponent {
    let currentTarget = target;
    if (currentTarget.live && getLiveSubagentView(currentTarget.sessionId) === undefined) {
      const fallback = resolveSubagentTarget(this.cwd, this.nodes, currentTarget.sessionId);
      if (!fallback || fallback === "ambiguous") {
        this.notifyUnavailable(currentTarget.sessionId);
        this.scheduleClose();
        return this.createSelector();
      }
      currentTarget = fallback;
    }
    return new SubagentSessionPanel({
      tui: this.tui,
      theme: this.theme,
      keybindings: this.keybindings,
      done: () => this.requestClose(),
      sessionId: currentTarget.sessionId,
      source: currentTarget.source,
      getNode: currentTarget.getNode,
      subscribeRegistry: (listener) => subagentRegistry.onChange(listener),
      viewportKeybindings: this.viewportKeybindings,
    });
  }

  private showSession(node: SubagentNode): void {
    const target = resolveSubagentTarget(this.cwd, this.nodes, node.sessionId);
    if (!target || target === "ambiguous") {
      this.notifyUnavailable(node.sessionId);
      this.scheduleClose();
      return;
    }
    const next = this.createSessionPanel(target);
    this.current.dispose?.();
    this.current = next;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    this.current.handleInput?.(data);
  }

  invalidate(): void {
    this.current.invalidate();
  }

  render(width: number): string[] {
    return this.current.render(width);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.closeTimer !== undefined) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    try {
      this.current.dispose?.();
    } finally {
      this.restoreFullscreenViewportBindings();
    }
  }
}

export function registerSubagentCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
  let commandOpen = false;
  pi.registerCommand("subagent", {
    description: "View a subagent session",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI || ctx.mode !== "tui" || !isRootSession(ctx)) {
        ctx.ui.notify("/subagent requires the root interactive UI.", "warning");
        return;
      }
      if (commandOpen) {
        ctx.ui.notify("The subagent viewer is already open.", "info");
        return;
      }

      commandOpen = true;
      try {
        const rootSessionId = readRootSessionId(ctx) || ctx.sessionManager.getSessionId();
        const nodes = subagentRegistry
          .forRoot(rootSessionId)
          .filter((node) => node.status === "running" && getLiveSubagentView(node.sessionId) !== undefined)
          .sort((left, right) => left.startedAt - right.startedAt);
        const query = args.trim();
        let initialTarget: SubagentPanelTarget | undefined;

        if (!query) {
          if (nodes.length === 0) {
            ctx.ui.notify("No running subagents are available to view.", "info");
            return;
          }
        } else {
          const resolvedTarget = resolveSubagentTarget(ctx.cwd, nodes, query);
          if (resolvedTarget === "ambiguous") {
            ctx.ui.notify(`Subagent "${query}" is ambiguous.`, "warning");
            return;
          }
          if (!resolvedTarget) {
            ctx.ui.notify(`Subagent "${query}" was not found.`, "warning");
            return;
          }
          initialTarget = resolvedTarget;
        }

        await ctx.ui.custom<void>((tui, theme, keybindings, done) => new SubagentCommandOverlay({
          tui,
          theme,
          keybindings,
          cwd: ctx.cwd,
          done: () => done(undefined),
          nodes,
          ...(initialTarget ? { initialTarget } : {}),
          notifyUnavailable: (sessionId) => {
            ctx.ui.notify(`Subagent "${sessionId}" is no longer available.`, "info");
          },
        }), {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "bottom-center",
            margin: { top: OVERLAY_VERTICAL_MARGIN, right: 0, bottom: OVERLAY_VERTICAL_MARGIN, left: 0 },
          },
        });
      } finally {
        commandOpen = false;
      }
    },
  });
}
