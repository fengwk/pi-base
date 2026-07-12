import {
  ExtensionSelectorComponent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { isRootSession, readRootSessionId } from "./depth.js";
import { subagentRegistry, type SubagentNode } from "./registry.js";
import { getLiveSubagentView, getPersistedSubagentView, type SubagentViewSource } from "./runner.js";
import { SubagentSessionPanel } from "./session-panel.js";

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

class SubagentCommandOverlay implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: () => void;
  private readonly notifyUnavailable: (sessionId: string) => void;
  private readonly nodes: SubagentNode[];
  private current: DisposableComponent;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    done: () => void;
    nodes: SubagentNode[];
    initialTarget?: SubagentPanelTarget;
    notifyUnavailable: (sessionId: string) => void;
  }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.done = options.done;
    this.notifyUnavailable = options.notifyUnavailable;
    this.nodes = options.nodes;
    this.current = options.initialTarget ? this.createSessionPanel(options.initialTarget) : this.createSelector();
  }

  private createSelector(): ExtensionSelectorComponent {
    const nodeByLabel = new Map<string, SubagentNode>();
    const labels = this.nodes.map((node) => {
      const label = formatChoice(node);
      nodeByLabel.set(label, node);
      return label;
    });
    return new ExtensionSelectorComponent(
      "View running subagent",
      labels,
      (label) => {
        const node = nodeByLabel.get(label);
        if (node) this.showSession(node);
      },
      this.done,
      { tui: this.tui },
    );
  }

  private createSessionPanel(target: SubagentPanelTarget): DisposableComponent {
    if (target.live && getLiveSubagentView(target.sessionId) === undefined) {
      this.notifyUnavailable(target.sessionId);
      queueMicrotask(this.done);
      return this.createSelector();
    }
    return new SubagentSessionPanel({
      tui: this.tui,
      theme: this.theme,
      keybindings: this.keybindings,
      done: this.done,
      sessionId: target.sessionId,
      source: target.source,
      getNode: target.getNode,
      subscribeRegistry: (listener) => subagentRegistry.onChange(listener),
    });
  }

  private showSession(node: SubagentNode): void {
    const target = createLiveTarget(node);
    if (!target) {
      this.notifyUnavailable(node.sessionId);
      queueMicrotask(this.done);
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
    this.current.dispose?.();
  }
}

export function registerSubagentCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("subagent", {
    description: "View a subagent session",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI || ctx.mode !== "tui" || !isRootSession(ctx)) {
        ctx.ui.notify("/subagent requires the root interactive UI.", "warning");
        return;
      }

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
        const liveNode = resolveRequestedNode(nodes, query);
        if (liveNode === "ambiguous") {
          ctx.ui.notify(`Subagent "${query}" is ambiguous.`, "warning");
          return;
        }
        if (liveNode) initialTarget = createLiveTarget(liveNode);
        if (!initialTarget) {
          const persisted = getPersistedSubagentView(ctx.cwd, query);
          if (persisted === "ambiguous") {
            ctx.ui.notify(`Subagent "${query}" is ambiguous.`, "warning");
            return;
          }
          if (!persisted) {
            ctx.ui.notify(`Subagent "${query}" was not found.`, "warning");
            return;
          }
          initialTarget = {
            sessionId: persisted.sessionId,
            source: persisted.source,
            live: false,
            getNode: () => subagentRegistry.get(persisted.sessionId),
          };
        }
      }

      await ctx.ui.custom<void>((tui, theme, keybindings, done) => new SubagentCommandOverlay({
        tui,
        theme,
        keybindings,
        done: () => done(undefined),
        nodes,
        ...(initialTarget ? { initialTarget } : {}),
        notifyUnavailable: (sessionId) => {
          ctx.ui.notify(`Subagent "${sessionId}" finished before the panel opened.`, "info");
        },
      }), {
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: "100%",
          anchor: "center",
          margin: { top: 1, right: 0, bottom: 1, left: 0 },
        },
      });
    },
  });
}
