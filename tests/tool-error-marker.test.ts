import { describe, expect, it } from "vitest";
import { inferToolResultIsError } from "../src/tool-result.js";
import { hasPiBaseToolErrorMarker, markPiBaseToolErrorDetails } from "../src/tool-error-marker.js";

describe("pi-base tool error marker", () => {
  it("lets tool_result infer errors from structured metadata before text fallback", () => {
    // Intent: pi's agent loop does not consume extra `result.isError` fields from
    // execute() results, so pi-base tools need a structured marker in details.
    const details = markPiBaseToolErrorDetails({ source: "test" });

    expect(hasPiBaseToolErrorMarker(details)).toBe(true);
    expect(inferToolResultIsError("any_mcp_tool", {
      content: [{ type: "text", text: "remote server returned a failure without Error prefix" }],
      details,
    } as any)).toBe(true);
  });
});
