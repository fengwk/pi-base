import { describe, expect, it } from "vitest";
import piBaseExtension from "../index.js";
import { applyAnthropicCompressionBoundaryCacheMarker } from "../src/anthropic-cache-boundary.js";
import { createToolRegistry } from "./helpers.js";

const PLACEHOLDER = "[pi-base context compression: older tool output omitted. Re-run the tool if you need those details.]";

function basePayload() {
  return {
    system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "read", input_schema: {}, cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "request" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_read_1", content: PLACEHOLDER },
          { type: "text", text: "latest", cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
      },
    ],
  };
}

describe("Anthropic compression boundary cache marker", () => {
  it("copies the following message marker to the last pi-base placeholder when marker budget is available", () => {
    const payload = basePayload();

    const changed = applyAnthropicCompressionBoundaryCacheMarker(payload);

    expect(changed).toBe(true);
    const boundary = payload.messages[1].content[0] as any;
    const source = payload.messages[1].content[1] as any;
    expect(boundary.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(source.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect((payload.system[0] as any).cache_control).toEqual({ type: "ephemeral" });
    expect((payload.tools[0] as any).cache_control).toEqual({ type: "ephemeral" });
  });

  it("moves the following message marker when adding one would exceed the Anthropic marker limit", () => {
    const payload = basePayload();
    payload.messages.splice(1, 0, {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_extra", name: "bash", input: {}, cache_control: { type: "ephemeral" } }],
    } as any);

    const changed = applyAnthropicCompressionBoundaryCacheMarker(payload);

    expect(changed).toBe(true);
    const boundary = payload.messages[2].content[0] as any;
    const source = payload.messages[2].content[1] as any;
    expect(boundary.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(source.cache_control).toBeUndefined();
    expect((payload.messages[1].content[0] as any).cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not move a marker that is before the placeholder", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "text", text: "already cached", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_1", content: PLACEHOLDER }] },
        { role: "user", content: [{ type: "text", text: "active tail" }] },
      ],
    };

    const changed = applyAnthropicCompressionBoundaryCacheMarker(payload);

    expect(changed).toBe(false);
    expect((payload.messages[1].content[0] as any).cache_control).toBeUndefined();
    expect((payload.messages[0].content[0] as any).cache_control).toEqual({ type: "ephemeral" });
  });

  it("does nothing when there is no pi-base placeholder", () => {
    const payload = basePayload();
    (payload.messages[1].content[0] as any).content = "full tool output";

    const changed = applyAnthropicCompressionBoundaryCacheMarker(payload);

    expect(changed).toBe(false);
    expect((payload.messages[1].content[1] as any).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  it("does not create a marker when only system or tool markers exist after compression", () => {
    const payload = {
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "read", input_schema: {}, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_1", content: PLACEHOLDER }] }],
    };

    const changed = applyAnthropicCompressionBoundaryCacheMarker(payload);

    expect(changed).toBe(false);
    expect((payload.messages[0].content[0] as any).cache_control).toBeUndefined();
    expect((payload.system[0] as any).cache_control).toEqual({ type: "ephemeral" });
    expect((payload.tools[0] as any).cache_control).toEqual({ type: "ephemeral" });
  });

  it("is applied through pi's before_provider_payload hook", async () => {
    const registry = createToolRegistry();
    piBaseExtension(registry.pi as any);
    const payload = basePayload();

    const result = await registry.emit("before_provider_payload", { payload }, {});

    expect(result).toEqual({ payload });
    expect((payload.messages[1].content[0] as any).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });
});
