import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LspClient, LspManager, lspManager } from "../src/lsp/client.js";
import { LspDiscoveryResolver } from "../src/lsp/discovery.js";
import { registerLspTools } from "../src/lsp/tools.js";
import { createTempWorkspace, createToolRegistry, getText, writeWorkspaceFile } from "./helpers.js";

function encodeMessage(payload: unknown): Buffer {
  const body = JSON.stringify(payload);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8");
}

function mockToolLspClient(overrides: Record<string, unknown> = {}): any {
  return {
    supportsMethod: () => true,
    serverId: () => "mock-server",
    ...overrides,
  };
}

describe("LspClient internals", () => {
  it("encodes utf16 character offsets from code point offsets", () => {
    const client = new LspClient("/tmp/demo", { id: "typescript", command: ["tsserver"], extensions: [".ts"] } as any);
    (client as any).fileContents.set("/tmp/demo/a.ts", "a😀b\n");
    (client as any).positionEncoding = "utf-16";
    expect((client as any).toEncodedCharacter("/tmp/demo/a.ts", 0, 2)).toBe(3);
  });

  it("encodes utf8 character offsets from code point offsets", () => {
    const client = new LspClient("/tmp/demo", { id: "typescript", command: ["tsserver"], extensions: [".ts"] } as any);
    (client as any).fileContents.set("/tmp/demo/a.ts", "a😀b\n");
    (client as any).positionEncoding = "utf-8";
    expect((client as any).toEncodedCharacter("/tmp/demo/a.ts", 0, 2)).toBe(Buffer.byteLength("a😀", "utf8"));
  });

  it("waits for publishDiagnostics instead of returning immediately", async () => {
    const client = new LspClient("/tmp/demo", { id: "typescript", command: ["tsserver"], extensions: [".ts"] } as any);
    const promise = (client as any).waitForPublishedDiagnostics("file:///tmp/demo.ts", 1000);
    setTimeout(() => {
      (client as any).onData(encodeMessage({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: "file:///tmp/demo.ts", diagnostics: [{ message: "boom" }] },
      }));
    }, 10);
    await expect(promise).resolves.toEqual([{ message: "boom" }]);
  });

  it("clears the diagnostics timeout once publishDiagnostics arrives", async () => {
    vi.useFakeTimers();
    try {
      const client = new LspClient("/tmp/demo", { id: "typescript", command: ["tsserver"], extensions: [".ts"] } as any);
      const uri = "file:///tmp/demo.ts";
      const promise = (client as any).waitForPublishedDiagnostics(uri, 1000);
      setTimeout(() => {
        (client as any).onData(encodeMessage({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri, diagnostics: [{ message: "boom" }] },
        }));
      }, 10);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      await expect(promise).resolves.toEqual([{ message: "boom" }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects diagnostics waits that never receive any server result", async () => {
    vi.useFakeTimers();
    try {
      const client = new LspClient("/tmp/demo", { id: "typescript", command: ["tsserver"], extensions: [".ts"], requestTimeoutMs: 100 } as any);
      const promise = (client as any).waitForPublishedDiagnostics("file:///tmp/demo.ts", 100);
      const assertion = expect(promise).rejects.toThrow(/LSP diagnostics timeout after 100ms/);
      await vi.advanceTimersByTimeAsync(120);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["file.mts", "typescript"],
    ["file.cts", "typescript"],
    ["file.mjs", "javascript"],
    ["file.cjs", "javascript"],
    ["file.pyi", "python"],
  ])("uses the correct didOpen languageId for %s", async (fileName, languageId) => {
    const root = await createTempWorkspace();
    const filePath = await writeWorkspaceFile(root, fileName, "export const x = 1;\n");
    const client = new LspClient(root, { id: "mock", command: ["mock"], extensions: [".ts"] } as any);
    const notifySpy = vi.spyOn(client as any, "notify");
    await client.openFile(filePath);
    expect(notifySpy).toHaveBeenCalledWith(
      "textDocument/didOpen",
      expect.objectContaining({ textDocument: expect.objectContaining({ languageId }) }),
    );
    notifySpy.mockRestore();
  });

  describe("supportsMethod", () => {
    function client(id: string, capabilities: Record<string, unknown>) {
      const c = new LspClient("/tmp/demo", { id, command: [id === "jdtls" ? "jdtls" : "mock"], extensions: [".ts"] } as any);
      (c as any).serverCapabilities = capabilities;
      return c;
    }

    it("reports workspace/symbol supported when capability is a boolean true", () => {
      expect(client("foo", { workspaceSymbolProvider: true }).supportsMethod("workspace/symbol")).toBe(true);
    });
    it("reports workspace/symbol supported when capability is options object", () => {
      expect(client("foo", { workspaceSymbolProvider: { resolveProvider: true } }).supportsMethod("workspace/symbol")).toBe(true);
    });
    it("reports workspace/symbol unsupported when capability is missing or false", () => {
      expect(client("foo", {}).supportsMethod("workspace/symbol")).toBe(false);
      expect(client("foo", { workspaceSymbolProvider: false }).supportsMethod("workspace/symbol")).toBe(false);
    });
    it("reports definition supported when capability is boolean true or options object", () => {
      expect(client("foo", { definitionProvider: true }).supportsMethod("textDocument/definition")).toBe(true);
      expect(client("foo", { definitionProvider: {} }).supportsMethod("textDocument/definition")).toBe(true);
      expect(client("foo", { definitionProvider: false }).supportsMethod("textDocument/definition")).toBe(false);
      expect(client("foo", {}).supportsMethod("textDocument/definition")).toBe(false);
    });
    it("always reports diagnostics supported (no pre-check; relies on timeout)", () => {
      // jdtls and others push diagnostics in practice even when the capability
      // is missing or uses a non-standard field, so we don't pre-check.
      expect(client("foo", {}).supportsMethod("textDocument/publishDiagnostics")).toBe(true);
      expect(client("foo", { publishDiagnosticsProvider: null }).supportsMethod("textDocument/publishDiagnostics")).toBe(true);
    });
    it("reports java/classFileContents only for jdtls", () => {
      expect(client("jdtls", {}).supportsMethod("java/classFileContents")).toBe(true);
      expect(client("typescript", {}).supportsMethod("java/classFileContents")).toBe(false);
    });
    it("treats jdtls wrapper executables as jdtls", () => {
      const c = new LspClient("/tmp/demo", { id: "jdtls", command: ["jdtls.cmd"], extensions: [".java"] } as any);
      expect(c.isJdtls()).toBe(true);
      expect(c.supportsMethod("java/classFileContents")).toBe(true);
    });
    it("returns true for unknown methods (no pre-check)", () => {
      expect(client("foo", {}).supportsMethod("workspace/executeCommand")).toBe(true);
    });
  });

  describe("requestTimeoutMs", () => {
    it("defaults to 60000ms when not configured", () => {
      const c = new LspClient("/tmp/demo", { id: "x", command: ["x"], extensions: [".x"] } as any);
      expect((c as any).requestTimeoutMs).toBe(60000);
    });
    it("honors a configured timeout", () => {
      const c = new LspClient("/tmp/demo", { id: "x", command: ["x"], extensions: [".x"], requestTimeoutMs: 90000 } as any);
      expect((c as any).requestTimeoutMs).toBe(90000);
    });
    it("rejects with a helpful hint when the request times out", async () => {
      vi.useFakeTimers();
      try {
        const c = new LspClient("/tmp/demo", { id: "gopls", command: ["gopls"], extensions: [".go"], requestTimeoutMs: 100 } as any);
        // Simulate a started process so `send` can run.
        (c as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        const promise = (c as any).send("workspace/symbol", { query: "x" });
        // Promise must not yet have settled.
        let settled = false;
        promise.catch(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(50);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(60);
        await expect(promise).rejects.toThrow(/Increase lsp\.servers\.gopls\.requestTimeoutMs/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the request timer once a response arrives", async () => {
      vi.useFakeTimers();
      try {
        const c = new LspClient("/tmp/demo", { id: "gopls", command: ["gopls"], extensions: [".go"], requestTimeoutMs: 100 } as any);
        (c as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        const promise = (c as any).send("workspace/symbol", { query: "x" });
        expect(vi.getTimerCount()).toBe(1);
        (c as any).onData(encodeMessage({ jsonrpc: "2.0", id: 1, result: [{ name: "Foo" }] }));
        await expect(promise).resolves.toEqual([{ name: "Foo" }]);
        expect(vi.getTimerCount()).toBe(0);
        // Advancing past the original timeout must not affect anything.
        await vi.advanceTimersByTimeAsync(500);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects send promptly when the caller aborts", async () => {
      vi.useFakeTimers();
      try {
        const c = new LspClient("/tmp/demo", { id: "gopls", command: ["gopls"], extensions: [".go"], requestTimeoutMs: 1000 } as any);
        (c as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        const controller = new AbortController();
        const promise = (c as any).send("workspace/symbol", { query: "x" }, controller.signal);
        controller.abort();
        await expect(promise).rejects.toThrow(/Operation aborted/);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("LspManager", () => {
    it("deduplicates concurrent client boot for the same workspace and server", async () => {
      const root = await createTempWorkspace();
      const binDir = join(root, "bin");
      const fakeServer = join(binDir, "fake-lsp");
      await mkdir(binDir, { recursive: true });
      await writeFile(fakeServer, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
      const filePath = await writeWorkspaceFile(root, "src/example.ts", "export const x = 1;\n");
      const resolver = new LspDiscoveryResolver({
        servers: {
          typescript: {
            command: [fakeServer],
            extensions: [".ts"],
          },
        },
      });
      const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
        (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
      });
      const initializeSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
      const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
      try {
        const [first, second] = await Promise.all([
          lspManager.getClient(filePath, resolver),
          lspManager.getClient(filePath, resolver),
        ]);
        expect(first).toBe(second);
        expect(startSpy).toHaveBeenCalledTimes(1);
        expect(initializeSpy).toHaveBeenCalledTimes(1);
      } finally {
        await lspManager.shutdownAll();
        startSpy.mockRestore();
        initializeSpy.mockRestore();
        stopSpy.mockRestore();
      }
    });
  });

  describe("diagnostics fallback", () => {
    it("returns pull diagnostics items when textDocument/diagnostic succeeds", async () => {
      const root = await createTempWorkspace();
      const filePath = await writeWorkspaceFile(root, "src/example.ts", "export const x = 1;\n");
      const client = new LspClient(root, { id: "mock", command: ["mock"], extensions: [".ts"] } as any);
      const items = [{ message: "from pull diagnostics" }];
      const openSpy = vi.spyOn(client, "openFile").mockResolvedValue(undefined);
      const sendSpy = vi.spyOn(client as any, "send").mockResolvedValue({ items });
      const waitSpy = vi.spyOn(client as any, "waitForPublishedDiagnostics");

      const result = await client.diagnostics(filePath);

      expect(openSpy).toHaveBeenCalledWith(filePath);
      expect(sendSpy).toHaveBeenCalledWith(
        "textDocument/diagnostic",
        { textDocument: { uri: pathToFileURL(filePath).href } },
        undefined,
      );
      expect(waitSpy).not.toHaveBeenCalled();
      expect(result).toBe(items);
    });
    it("re-throws when the diagnostic request fails for a non-Method-Not-Found reason", async () => {
      const root = await createTempWorkspace();
      const filePath = await writeWorkspaceFile(root, "src/example.ts", "export const x = 1;\n");
      const client = new LspClient(root, { id: "mock", command: ["mock"], extensions: [".ts"] } as any);
      const sendSpy = vi.spyOn(client as any, "send").mockRejectedValue(new Error("LSP request timeout (textDocument/diagnostic) after 100ms"));
      await expect(client.diagnostics(filePath)).rejects.toThrow(/LSP request timeout/);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it("re-throws JSON-RPC Internal Error (-32603) instead of treating it as a transient startup race", async () => {
      const root = await createTempWorkspace();
      const filePath = await writeWorkspaceFile(root, "src/example.ts", "export const x = 1;\n");
      const client = new LspClient(root, { id: "mock-lsp", command: ["mock-lsp"], extensions: [".java"] } as any);
      const internalError = new Error("Internal error") as Error & { code?: number };
      internalError.code = -32603;
      const sendSpy = vi.spyOn(client as any, "send").mockRejectedValue(internalError);
      const waitSpy = vi.spyOn(client as any, "waitForPublishedDiagnostics");
      await expect(client.diagnostics(filePath)).rejects.toThrow(/^Internal error$/);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(waitSpy).not.toHaveBeenCalled();
    });

    it("falls back to publishDiagnostics when the server reports Method Not Found (-32601)", async () => {
      const root = await createTempWorkspace();
      const filePath = await writeWorkspaceFile(root, "src/example.ts", "export const x = 1;\n");
      const client = new LspClient(root, { id: "mock", command: ["mock"], extensions: [".ts"], requestTimeoutMs: 200 } as any);
      const methodNotFound = new Error("Method not found: textDocument/diagnostic") as Error & { code?: number };
      methodNotFound.code = -32601;
      const sendSpy = vi.spyOn(client as any, "send").mockRejectedValue(methodNotFound);
      // Deliver diagnostics via publishDiagnostics right away to resolve the wait.
      setTimeout(() => {
        (client as any).onData(encodeMessage({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri: pathToFileURL(filePath).href, diagnostics: [{ message: "boom" }] },
        }));
      }, 10);
      const result = await client.diagnostics(filePath);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual([{ message: "boom" }]);
    });

    it("surfaces a generic actionable hint when transient Internal error fallback times out", async () => {
      vi.useFakeTimers();
      try {
        const filePath = "/tmp/demo/src/App.java";
        const client = new LspClient("/tmp/demo", { id: "mock-lsp", command: ["mock-lsp"], extensions: [".java"], requestTimeoutMs: 100 } as any);
        vi.spyOn(client, "openFile").mockResolvedValue(undefined);
        const internalError = new Error("Internal error") as Error & { code?: number };
        const sendSpy = vi.spyOn(client as any, "send").mockRejectedValue(internalError);
        const promise = client.diagnostics(filePath);
        const assertion = expect(promise).rejects.toThrow(/LSP server 'mock-lsp' returned "Internal error"/);
        await vi.advanceTimersByTimeAsync(120);
        await assertion;
        await expect(promise).rejects.toThrow(/requestTimeoutMs/);
        expect(sendSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("uses the target file directory when building the resolver for absolute paths outside cwd", async () => {
    const rootA = await createTempWorkspace();
    const rootB = await createTempWorkspace();
    const absoluteFile = await writeWorkspaceFile(rootB, "src/example.ts", "export const x = 1;\n");
    const registry = createToolRegistry();
    let seenBaseDir: string | undefined;
    registerLspTools(registry.pi as any, {
      resolverFactory: (baseDir: string) => {
        seenBaseDir = baseDir;
        return new LspDiscoveryResolver({});
      },
    });
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => mockToolLspClient({ diagnostics: async () => [] });
    try {
      const result = await registry.getTool("lsp_diagnostics").execute("1", { path: absoluteFile }, undefined, undefined, { cwd: rootA });
      expect(getText(result)).toBe("No diagnostics found");
      expect(seenBaseDir).toBe(join(rootB, "src"));
    } finally {
      lspManager.getClient = original;
    }
  });

  it("returns an abort error when the signal is already aborted before the tool starts", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const controller = new AbortController();
    controller.abort();
    const result = await registry.getTool("lsp_diagnostics").execute("1", { path: "src/example.ts" }, controller.signal, undefined, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Operation aborted");
  });

  it("returns an abort error when getClient is still in flight and the caller aborts", async () => {
    const registry = createToolRegistry();
    registerLspTools(registry.pi as any);
    const original = lspManager.getClient.bind(lspManager);
    lspManager.getClient = async () => new Promise(() => undefined) as any;
    const controller = new AbortController();
    const pending = registry.getTool("lsp_diagnostics").execute("1", { path: "src/example.ts" }, controller.signal, undefined, { cwd: process.cwd() });
    controller.abort();
    try {
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Operation aborted");
    } finally {
      lspManager.getClient = original;
    }
  });

  describe("resolver isolation", () => {
    it("does not leak server config from one resolver to another", () => {
      const projectA = new LspDiscoveryResolver({
        servers: { jdtls: { command: ["jdtls"], extensions: [".java"] } },
      });
      const projectB = new LspDiscoveryResolver({});
      expect(projectA.supportsLsp("/tmp/A.java").supported).toBe(true);
      expect(projectB.supportsLsp("/tmp/A.java").supported).toBe(false);
      expect(() => projectB.findServerForFile("/tmp/A.java")).toThrowError(/No LSP server configured/);
    });

    it("does not treat resolver instances as shared global config", () => {
      const projectA = new LspDiscoveryResolver({ servers: { ts: { command: ["ts-lsp"], extensions: [".ts"] } } });
      const projectB = new LspDiscoveryResolver({});
      expect(projectA.getConfig().servers?.ts?.command).toEqual(["ts-lsp"]);
      expect(projectB.getConfig().servers).toBeUndefined();
    });

    it("uses the resolver passed to getClient, not a shared global config", async () => {
      const root = await createTempWorkspace();
      const filePath = await writeWorkspaceFile(root, "src/example.ts", "export const x = 1;\n");
      // resolverA: declares a server for .ts but the binary is not installed.
      const resolverA = new LspDiscoveryResolver({
        servers: { ts: { command: ["definitely-missing-binary-a"], extensions: [".ts"] } },
      });
      // resolverB: no servers at all.
      const resolverB = new LspDiscoveryResolver({});
      const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
        (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
      });
      const initializeSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
      const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
      try {
        // resolverA rejects because the binary is not installed.
        await expect(lspManager.getClient(filePath, resolverA)).rejects.toThrow(/is not installed/);
        // resolverB rejects because no servers are configured.
        await expect(lspManager.getClient(filePath, resolverB)).rejects.toThrow(/No LSP server configured/);
        // Neither call should have started a client.
        expect(startSpy).not.toHaveBeenCalled();
        expect(initializeSpy).not.toHaveBeenCalled();
      } finally {
        await lspManager.shutdownAll();
        startSpy.mockRestore();
        initializeSpy.mockRestore();
        stopSpy.mockRestore();
      }
    });
  });

  describe("idle eviction", () => {
    it("stops a client that has been idle past the timeout", async () => {
      vi.useFakeTimers();
      try {
        const root = await createTempWorkspace();
        const binDir = join(root, "bin");
        await mkdir(binDir, { recursive: true });
        await writeFile(join(binDir, "fake-lsp"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
        const filePath = await writeWorkspaceFile(root, "src/example.ts", "x\n");
        const resolver = new LspDiscoveryResolver({
          servers: { typescript: { command: [join(binDir, "fake-lsp")], extensions: [".ts"] } },
        });
        const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        });
        const initSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
        const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
        const manager = new LspManager({ idleTimeoutMs: 1000 });
        try {
          await manager.getClient(filePath, resolver);
          expect(stopSpy).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1500);
          expect(stopSpy).toHaveBeenCalledTimes(1);
        } finally {
          await manager.shutdownAll();
          startSpy.mockRestore();
          initSpy.mockRestore();
          stopSpy.mockRestore();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not stop a client that received activity within the timeout window", async () => {
      vi.useFakeTimers();
      try {
        const root = await createTempWorkspace();
        const binDir = join(root, "bin");
        await mkdir(binDir, { recursive: true });
        await writeFile(join(binDir, "fake-lsp"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
        const filePath = await writeWorkspaceFile(root, "src/example.ts", "x\n");
        const resolver = new LspDiscoveryResolver({
          servers: { typescript: { command: [join(binDir, "fake-lsp")], extensions: [".ts"] } },
        });
        const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        });
        const initSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
        const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
        const manager = new LspManager({ idleTimeoutMs: 1000 });
        try {
          const client = await manager.getClient(filePath, resolver);
          // Trigger activity: send a request at t=0
          const sendPromise = (client as any).send("workspace/symbol", { query: "x" });
          // Advance 800ms (still within the original idle window)
          await vi.advanceTimersByTimeAsync(800);
          // Reply to the send at t=800; the response wrapper updates lastUsedAt
          (client as any).onData(encodeMessage({ jsonrpc: "2.0", id: 1, result: [] }));
          await sendPromise;
          // Advance another 800ms (now t=1600, but lastUsedAt = 800; diff = 800 < 1000)
          await vi.advanceTimersByTimeAsync(800);
          expect(stopSpy).not.toHaveBeenCalled();
          // Advance past the new deadline (t=800 + 1000 = 1800, currently at 1600; advance 300 more)
          await vi.advanceTimersByTimeAsync(300);
          expect(stopSpy).toHaveBeenCalledTimes(1);
        } finally {
          await manager.shutdownAll();
          startSpy.mockRestore();
          initSpy.mockRestore();
          stopSpy.mockRestore();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not stop a client whose boot is still in flight when the check fires", async () => {
      vi.useFakeTimers();
      try {
        const root = await createTempWorkspace();
        const binDir = join(root, "bin");
        await mkdir(binDir, { recursive: true });
        await writeFile(join(binDir, "fake-lsp"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
        const filePath = await writeWorkspaceFile(root, "src/example.ts", "x\n");
        const resolver = new LspDiscoveryResolver({
          servers: { typescript: { command: [join(binDir, "fake-lsp")], extensions: [".ts"] } },
        });
        // Make `start` block on a manually-controlled promise so the boot
        // is in flight when the timer fires.
        let resolveStart!: () => void;
        const startGate = new Promise<void>((r) => { resolveStart = r; });
        const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
          await startGate;
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        });
        const initSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
        const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
        const manager = new LspManager({ idleTimeoutMs: 500 });
        try {
          const bootPromise = manager.getClient(filePath, resolver);
          // Yield once so the boot is in flight inside `start`.
          await Promise.resolve();
          // Advance well past the timeout: the boot is still pending.
          await vi.advanceTimersByTimeAsync(2000);
          expect(stopSpy).not.toHaveBeenCalled();
          // Release the boot.
          resolveStart();
          await bootPromise;
          // After the boot, the manager re-arms; advancing past the new
          // deadline should evict the now-live client.
          await vi.advanceTimersByTimeAsync(1000);
          expect(stopSpy).toHaveBeenCalledTimes(1);
        } finally {
          await manager.shutdownAll();
          startSpy.mockRestore();
          initSpy.mockRestore();
          stopSpy.mockRestore();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses the boot's `finally`-recorded activity as the deadline (not the getClient start time)", async () => {
      // A new boot's `clients.set` runs before its `finally` records
      // activity. The check must NOT treat that moment as "dead since
      // the original getClient" — it must wait for activity recorded
      // by the boot's `finally` (or any subsequent call) before
      // deciding to evict.
      vi.useFakeTimers();
      try {
        const root = await createTempWorkspace();
        const binDir = join(root, "bin");
        await mkdir(binDir, { recursive: true });
        await writeFile(join(binDir, "fake-lsp"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
        const filePath = await writeWorkspaceFile(root, "src/example.ts", "x\n");
        const resolver = new LspDiscoveryResolver({
          servers: { typescript: { command: [join(binDir, "fake-lsp")], extensions: [".ts"] } },
        });
        const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        });
        const initSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
        const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
        const manager = new LspManager({ idleTimeoutMs: 1000 });
        try {
          // Simulate: a previous getClient was made, ran for a while,
          // and eventually the boot completed. The "current time" is
          // far past the original getClient start. We verify the
          // client's deadline is measured from the boot's `finally`
          // (which is the moment activity was actually recorded),
          // not from any earlier time.
          const client = await manager.getClient(filePath, resolver);
          // The boot's `finally` recorded activity NOW. Advance
          // less than the idle timeout: client must still be alive.
          await vi.advanceTimersByTimeAsync(500);
          expect(stopSpy).not.toHaveBeenCalled();
          // Advance past the idle timeout: NOW the client is evicted.
          await vi.advanceTimersByTimeAsync(600);
          expect(stopSpy).toHaveBeenCalledTimes(1);
        } finally {
          await manager.shutdownAll();
          startSpy.mockRestore();
          initSpy.mockRestore();
          stopSpy.mockRestore();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not arm the timer when no LSP calls are made", async () => {
      vi.useFakeTimers();
      try {
        const root = await createTempWorkspace();
        const binDir = join(root, "bin");
        await mkdir(binDir, { recursive: true });
        await writeFile(join(binDir, "fake-lsp"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
        const filePath = await writeWorkspaceFile(root, "src/example.ts", "x\n");
        const resolver = new LspDiscoveryResolver({
          servers: { typescript: { command: [join(binDir, "fake-lsp")], extensions: [".ts"] } },
        });
        const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        });
        const initSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
        const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
        const manager = new LspManager({ idleTimeoutMs: 1000 });
        try {
          await manager.getClient(filePath, resolver);
          // One timer is armed after getClient.
          expect(vi.getTimerCount()).toBe(1);
          // Run the check: it should evict the client and NOT re-arm.
          await vi.advanceTimersByTimeAsync(1500);
          expect(stopSpy).toHaveBeenCalledTimes(1);
          expect(vi.getTimerCount()).toBe(0);
          // Further advances don't fire any more timers.
          await vi.advanceTimersByTimeAsync(10_000);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          await manager.shutdownAll();
          startSpy.mockRestore();
          initSpy.mockRestore();
          stopSpy.mockRestore();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("only evicts clients that are past their deadline when multiple clients exist", async () => {
      vi.useFakeTimers();
      try {
        const root = await createTempWorkspace();
        const binDir = join(root, "bin");
        await mkdir(binDir, { recursive: true });
        await writeFile(join(binDir, "fake-lsp"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
        // Two roots → two distinct client keys
        const rootA = await createTempWorkspace();
        const rootB = await createTempWorkspace();
        const fileA = await writeWorkspaceFile(rootA, "src/a.ts", "a\n");
        const fileB = await writeWorkspaceFile(rootB, "src/b.ts", "b\n");
        const resolver = new LspDiscoveryResolver({
          servers: { typescript: { command: [join(binDir, "fake-lsp")], extensions: [".ts"] } },
        });
        const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        });
        const initSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
        const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
        const manager = new LspManager({ idleTimeoutMs: 1000 });
        try {
          const clientA = await manager.getClient(fileA, resolver);
          await manager.getClient(fileB, resolver);
          // Touch clientA at t=900 to keep it alive.
          await vi.advanceTimersByTimeAsync(900);
          const sendA = (clientA as any).send("workspace/symbol", { query: "a" });
          (clientA as any).onData(encodeMessage({ jsonrpc: "2.0", id: 1, result: [] }));
          await sendA;
          // Advance to t=1100. B's lastUsedAt=0 (diff=1100 ≥ 1000, kill).
          // A's lastUsedAt=900 (diff=200 < 1000, keep).
          await vi.advanceTimersByTimeAsync(200);
          expect(stopSpy).toHaveBeenCalledTimes(1);
          // Now advance past A's deadline (900 + 1000 = 1900, currently at 1100; advance 900 more).
          await vi.advanceTimersByTimeAsync(900);
          expect(stopSpy).toHaveBeenCalledTimes(2);
        } finally {
          await manager.shutdownAll();
          startSpy.mockRestore();
          initSpy.mockRestore();
          stopSpy.mockRestore();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the idle timer on shutdownAll", async () => {
      vi.useFakeTimers();
      try {
        const root = await createTempWorkspace();
        const binDir = join(root, "bin");
        await mkdir(binDir, { recursive: true });
        await writeFile(join(binDir, "fake-lsp"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
        const filePath = await writeWorkspaceFile(root, "src/example.ts", "x\n");
        const resolver = new LspDiscoveryResolver({
          servers: { typescript: { command: [join(binDir, "fake-lsp")], extensions: [".ts"] } },
        });
        const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        });
        const initSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
        const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
        const manager = new LspManager({ idleTimeoutMs: 1000 });
        try {
          await manager.getClient(filePath, resolver);
          expect(vi.getTimerCount()).toBe(1);
          await manager.shutdownAll();
          expect(vi.getTimerCount()).toBe(0);
          // Advancing time after shutdown must not fire any timer.
          await vi.advanceTimersByTimeAsync(10_000);
          expect(stopSpy).toHaveBeenCalledTimes(1); // shutdownAll itself stopped the client
        } finally {
          startSpy.mockRestore();
          initSpy.mockRestore();
          stopSpy.mockRestore();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("removes the dead client from the pool when a replacement boot fails", async () => {
      const root = await createTempWorkspace();
      const binDir = join(root, "bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, "fake-lsp"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
      const filePath = await writeWorkspaceFile(root, "src/example.ts", "x\n");
      const resolver = new LspDiscoveryResolver({
        servers: { typescript: { command: [join(binDir, "fake-lsp")], extensions: [".ts"] } },
      });
      // First boot: success. Second boot: failure. Third+ boot: success.
      const startSpy = vi.spyOn(LspClient.prototype, "start")
        .mockImplementationOnce(async function (this: any) {
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        })
        .mockImplementationOnce(async function (this: any) {
          throw new Error("simulated boot failure");
        })
        .mockImplementation(async function (this: any) {
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        });
      const initSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
      const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
      const manager = new LspManager({ idleTimeoutMs: 5000 });
      try {
        // 1) First getClient: success, client lives in the pool.
        const first = await manager.getClient(filePath, resolver);
        expect(startSpy).toHaveBeenCalledTimes(1);
        // 2) Force the first client to look dead.
        (first as any).proc = { stdin: { write: () => undefined }, exitCode: 1, killed: true };
        // 3) Second getClient: triggers boot, boot fails. The boot
        //    stops the stale client and the new (failed) client.
        await expect(manager.getClient(filePath, resolver)).rejects.toThrow(/simulated/);
        expect(startSpy).toHaveBeenCalledTimes(2);
        // Both the dead client and the new failed client were stopped.
        expect(stopSpy).toHaveBeenCalledTimes(2);
        // 4) Third getClient: should boot fresh, not reuse the dead first.
        const third = await manager.getClient(filePath, resolver);
        expect(startSpy).toHaveBeenCalledTimes(3);
        expect(third).not.toBe(first);
        // shutdownAll stops only the surviving (third) client, not the
        // already-stopped dead/failed pair.
        await manager.shutdownAll();
        expect(stopSpy).toHaveBeenCalledTimes(3);
      } finally {
        startSpy.mockRestore();
        initSpy.mockRestore();
        stopSpy.mockRestore();
      }
    });

    it("ignores a late onData from a killed client (no new idle timer armed)", async () => {
      vi.useFakeTimers();
      try {
        const root = await createTempWorkspace();
        const binDir = join(root, "bin");
        await mkdir(binDir, { recursive: true });
        await writeFile(join(binDir, "fake-lsp"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
        const filePath = await writeWorkspaceFile(root, "src/example.ts", "x\n");
        const resolver = new LspDiscoveryResolver({
          servers: { typescript: { command: [join(binDir, "fake-lsp")], extensions: [".ts"] } },
        });
        const startSpy = vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: any) {
          (this as any).proc = { stdin: { write: () => undefined }, exitCode: null, killed: false };
        });
        const initSpy = vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
        const stopSpy = vi.spyOn(LspClient.prototype, "stop").mockResolvedValue(undefined);
        const manager = new LspManager({ idleTimeoutMs: 1000 });
        try {
          const client = await manager.getClient(filePath, resolver);
          // We never call `client.send`: the only timer armed is the
          // idle timer the manager scheduled.
          expect(vi.getTimerCount()).toBe(1);
          // Advance past the idle deadline: the check fires, the
          // client is killed, the idle timer is cleared.
          await vi.advanceTimersByTimeAsync(1500);
          expect(stopSpy).toHaveBeenCalledTimes(1);
          expect(vi.getTimerCount()).toBe(0);
          // Late traffic from the killed client arrives. `onData` calls
          // `onActivity` -> `noteActivity`; without the
          // `clients.has(key)` guard this would arm a fresh idle timer
          // for an already-evicted key. With the guard, the manager
          // stays quiet.
          (client as any).onData(encodeMessage({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "late" } }));
          expect(vi.getTimerCount()).toBe(0);
          // Further advances must not fire anything either.
          await vi.advanceTimersByTimeAsync(10_000);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          await manager.shutdownAll();
          startSpy.mockRestore();
          initSpy.mockRestore();
          stopSpy.mockRestore();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
