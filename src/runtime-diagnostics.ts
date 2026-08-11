import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRootSession, readRootSessionId } from "./subagent/depth.js";

type RuntimeDiagnosticContext = Pick<ExtensionContext, "hasUI" | "sessionManager" | "ui">;

interface RuntimeDiagnostic {
  variant: "warning" | "error";
  message: string;
  stderrMessage: string;
  error?: unknown;
}

type RuntimeDiagnosticHost = (diagnostic: RuntimeDiagnostic) => void;
const hosts = new Map<string, RuntimeDiagnosticHost>();

function emitLocalDiagnostic(ctx: RuntimeDiagnosticContext, diagnostic: RuntimeDiagnostic): void {
  if (ctx.hasUI) {
    ctx.ui.notify(diagnostic.message, diagnostic.variant);
    return;
  }
  if (diagnostic.variant === "warning") {
    console.warn(diagnostic.stderrMessage);
  } else if (diagnostic.error === undefined) {
    console.error(diagnostic.stderrMessage);
  } else {
    console.error(diagnostic.stderrMessage, diagnostic.error);
  }
}

function reportRuntimeDiagnostic(ctx: RuntimeDiagnosticContext, diagnostic: RuntimeDiagnostic): void {
  if (isRootSession(ctx)) {
    emitLocalDiagnostic(ctx, diagnostic);
    return;
  }

  const host = hosts.get(readRootSessionId(ctx));
  if (!host) return;
  try {
    host(diagnostic);
  } catch {
    // Diagnostics must not fail the child session if its root UI is already stale.
  }
}

/**
 * Interactive Pi owns the terminal, so raw stderr writes can overwrite the editor.
 * Headless subagents relay through their root session because they share the same process streams.
 */
export function reportRuntimeWarning(
  ctx: RuntimeDiagnosticContext,
  message: string,
  stderrMessage = message,
): void {
  reportRuntimeDiagnostic(ctx, { variant: "warning", message, stderrMessage });
}

export function reportRuntimeError(
  ctx: RuntimeDiagnosticContext,
  message: string,
  stderrMessage = message,
  error?: unknown,
): void {
  reportRuntimeDiagnostic(ctx, { variant: "error", message, stderrMessage, error });
}

/** Register the root session that owns managed UI or top-level stderr for its child tree. */
export function registerRuntimeDiagnosticHost(ctx: RuntimeDiagnosticContext): () => void {
  if (!isRootSession(ctx)) return () => undefined;
  const rootSessionId = readRootSessionId(ctx);
  if (!rootSessionId) return () => undefined;

  const host: RuntimeDiagnosticHost = (diagnostic) => emitLocalDiagnostic(ctx, diagnostic);
  hosts.set(rootSessionId, host);
  return () => {
    if (hosts.get(rootSessionId) === host) hosts.delete(rootSessionId);
  };
}
