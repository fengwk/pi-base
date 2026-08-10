import { describe, expect, it } from "vitest";
import { createMcpToolDefinition } from "../src/mcp/adapter.js";
import type { McpToolCallResult } from "../src/mcp/types.js";

function createTool(result: McpToolCallResult) {
  return createMcpToolDefinition({
    serverKey: "media",
    serverConfig: { type: "remote", transport: "streamable-http", url: "https://example.com/mcp" },
    tool: { name: "inspect" },
    callTool: async () => result,
  });
}

async function execute(result: McpToolCallResult) {
  return createTool(result).execute("call-1", {}, undefined, undefined, {} as any);
}

describe("MCP result content adaptation", () => {
  it("preserves valid images as native image content", async () => {
    // Intent: image-capable models must receive MCP images as image blocks rather than JSON text
    // or placeholders.
    const result = await execute({
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });

    expect(result.content).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect((result as any).isError).not.toBe(true);
  });

  it("surfaces structured content alongside human-readable text", async () => {
    // Intent: MCP responses may carry both content forms; keeping only the display text silently
    // drops machine-readable output that the model still needs.
    const result = await execute({
      content: [{ type: "text", text: "summary" }],
      structuredContent: { answer: 42, source: "kb" },
    });
    const text = result.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    expect(text).toContain("summary");
    expect(text).toContain("[structured content]");
    expect(text).toContain('"answer": 42');
  });

  it("does not duplicate structured content already present as serialized text", async () => {
    // Intent: MCP recommends mirroring structuredContent in a text block for compatibility;
    // adding the same JSON again would needlessly double context usage.
    const structured = { answer: 42 };
    const serialized = JSON.stringify(structured, null, 2);
    const result = await execute({
      content: [{ type: "text", text: serialized }],
      structuredContent: structured,
    });

    expect(result.content).toEqual([{ type: "text", text: serialized }]);
  });

  it("summarizes audio and embedded blobs without leaking their base64 payloads", async () => {
    // Intent: pi-ai has no audio block and embedded resource blobs can be large or sensitive;
    // only bounded metadata may enter model context.
    const audio = "YXVkaW8tc2VjcmV0";
    const blob = Buffer.from("binary-payload").toString("base64");
    const result = await execute({
      content: [
        { type: "audio", data: audio, mimeType: "audio/mpeg" },
        {
          type: "resource",
          resource: { uri: "file:///data.bin", mimeType: "application/octet-stream", blob },
        },
      ],
    });
    const text = result.content.map((item: any) => item.text ?? "").join("\n");

    expect(text).toContain("audio/mpeg");
    expect(text).toContain("file:///data.bin");
    expect(text).toContain("omitted");
    expect(text).not.toContain(audio);
    expect(text).not.toContain(blob);
  });

  it("never converts binary error payloads into text", async () => {
    // Intent: error results are rendered as text, so blindly stringifying binary MCP blocks would
    // leak their complete base64 data into the conversation.
    const image = "aW1hZ2Utc2VjcmV0";
    const audio = "YXVkaW8tc2VjcmV0";
    const blob = Buffer.from("resource-secret").toString("base64");
    const result = await execute({
      isError: true,
      content: [
        { type: "image", data: image, mimeType: "image/png" },
        { type: "audio", data: audio, mimeType: "audio/mpeg" },
        {
          type: "resource",
          resource: { uri: "file:///error.bin", mimeType: "application/octet-stream", blob },
        },
      ],
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;

    expect((result as any).isError).toBe(true);
    expect(text).toContain("image content omitted");
    expect(text).toContain("audio content omitted");
    expect(text).toContain("file:///error.bin");
    expect(text).not.toContain(image);
    expect(text).not.toContain(audio);
    expect(text).not.toContain(blob);
  });

  it("renders resource links and inline text resources as readable text", async () => {
    // Intent: resource metadata and inline documents are useful model context and should not be
    // reduced to generic omitted-content placeholders.
    const result = await execute({
      content: [
        {
          type: "resource_link",
          uri: "file:///docs/spec.md",
          title: "Specification",
          mimeType: "text/markdown",
          description: "Design contract",
        },
        {
          type: "resource",
          resource: { uri: "file:///docs/notes.md", mimeType: "text/markdown", text: "# Notes" },
        },
      ],
    });
    const text = result.content.map((item: any) => item.text ?? "").join("\n");

    expect(text).toContain("Specification");
    expect(text).toContain("file:///docs/spec.md");
    expect(text).toContain("Design contract");
    expect(text).toContain("# Notes");
  });
});
