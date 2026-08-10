import { describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import { convertJsonSchemaToTypeBox } from "../src/mcp/schema.js";

describe("convertJsonSchemaToTypeBox", () => {
  it("preserves shared schema metadata on primitive schemas", () => {
    // Intent: MCP tools often rely on description/default/examples for model
    // guidance, so conversion must not strip those fields from primitives.
    const schema: any = convertJsonSchemaToTypeBox({
      type: "string",
      title: "Search query",
      description: "Text to search for.",
      default: "TODO",
      examples: ["fixme"],
      minLength: 1,
      maxLength: 100,
      pattern: "^[A-Z]+$",
    });

    expect(schema.type).toBe("string");
    expect(schema.title).toBe("Search query");
    expect(schema.description).toBe("Text to search for.");
    expect(schema.default).toBe("TODO");
    expect(schema.examples).toEqual(["fixme"]);
    expect(schema.minLength).toBe(1);
    expect(schema.maxLength).toBe(100);
    expect(schema.pattern).toBe("^[A-Z]+$");
  });

  it("converts const, enum, anyOf, oneOf, and type arrays into literals and unions", () => {
    // Intent: remote MCP servers commonly express constrained parameters with
    // these JSON Schema constructs; the model-visible TypeBox schema must keep
    // those constraints instead of degrading to Any.
    expect((convertJsonSchemaToTypeBox({ const: "fixed" }) as any).const).toBe("fixed");
    expect((convertJsonSchemaToTypeBox({ const: null }) as any).type).toBe("null");

    const enumSchema: any = convertJsonSchemaToTypeBox({ enum: ["red", 2, true, null] });
    expect(enumSchema.anyOf.map((entry: any) => entry.const ?? entry.type)).toEqual(["red", 2, true, "null"]);

    const anyOfSchema: any = convertJsonSchemaToTypeBox({
      anyOf: [{ type: "string" }, { type: "integer", minimum: 1 }],
    });
    expect(anyOfSchema.anyOf.map((entry: any) => entry.type)).toEqual(["string", "integer"]);
    expect(anyOfSchema.anyOf[1].minimum).toBe(1);

    const oneOfSchema: any = convertJsonSchemaToTypeBox({
      oneOf: [{ type: "boolean" }, { type: "null" }],
    });
    expect(oneOfSchema.anyOf.map((entry: any) => entry.type)).toEqual(["boolean", "null"]);

    const typeArraySchema: any = convertJsonSchemaToTypeBox({ type: ["string", "null"] });
    expect(typeArraySchema.anyOf.map((entry: any) => entry.type)).toEqual(["string", "null"]);
  });

  it("converts object required properties and array item schemas", () => {
    // Intent: MCP parameter objects need required/optional fidelity; arrays
    // should preserve both single item schemas and tuple-like item unions.
    const objectSchema: any = convertJsonSchemaToTypeBox({
      type: "object",
      description: "Tool args",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    });

    expect(objectSchema.type).toBe("object");
    expect(objectSchema.description).toBe("Tool args");
    expect(objectSchema.required).toEqual(["query"]);
    expect(objectSchema.properties.query.type).toBe("string");
    expect(objectSchema.properties.limit.type).toBe("integer");
    expect(objectSchema.properties.limit.minimum).toBe(1);
    expect(objectSchema.properties.limit.maximum).toBe(20);

    const arraySchema: any = convertJsonSchemaToTypeBox({
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
    });
    expect(arraySchema.type).toBe("array");
    expect(arraySchema.items.anyOf.map((entry: any) => entry.type)).toEqual(["string", "number"]);

    const singleItemArray: any = convertJsonSchemaToTypeBox({
      type: "array",
      items: { type: "boolean" },
    });
    expect(singleItemArray.items.type).toBe("boolean");
  });

  it("falls back to Any for missing, invalid, or unknown schema shapes", () => {
    // Intent: malformed MCP schemas should not break tool registration; they
    // should degrade predictably to a permissive schema.
    expect((convertJsonSchemaToTypeBox(undefined) as any).type).toBeUndefined();
    expect((convertJsonSchemaToTypeBox({ type: "custom" }) as any).type).toBeUndefined();
    expect((convertJsonSchemaToTypeBox({ properties: { value: { type: "string" } } }) as any).type).toBe("object");
    expect((convertJsonSchemaToTypeBox({ items: { type: "string" } }) as any).type).toBe("array");
  });

  it("preserves allOf intersection semantics for primitive constraints", () => {
    // Intent: JSON Schema allOf is logical AND; treating it as a union or dropping a
    // constraint-only branch would accept invalid MCP arguments.
    const stringSchema: any = convertJsonSchemaToTypeBox({
      allOf: [
        { type: "string" },
        { minLength: 3, pattern: "^[a-z]+$" },
      ],
    });
    const stringValidator = Compile(stringSchema);
    expect(stringSchema.allOf).toHaveLength(2);
    expect(stringValidator.Check("abc")).toBe(true);
    expect(stringValidator.Check("ab")).toBe(false);
    expect(stringValidator.Check("ABC")).toBe(false);
    expect(stringValidator.Check(3)).toBe(false);

    const integerValidator = Compile(convertJsonSchemaToTypeBox({
      allOf: [{ type: "integer" }, { minimum: 10 }],
    }));
    expect(integerValidator.Check(9)).toBe(false);
    expect(integerValidator.Check(10)).toBe(true);

    const ambiguous: any = convertJsonSchemaToTypeBox({
      allOf: [{ type: ["string", "null"] }, { minLength: 3 }],
    });
    const ambiguousValidator = Compile(ambiguous);
    expect(ambiguousValidator.Check(null)).toBe(true);
    expect(ambiguousValidator.Check("ab")).toBe(false);
    expect(ambiguousValidator.Check("abc")).toBe(true);

    const siblingValidator = Compile(convertJsonSchemaToTypeBox({
      type: "string",
      minLength: 3,
      allOf: [{ pattern: "^a" }],
    }));
    expect(siblingValidator.Check("abc")).toBe(true);
    expect(siblingValidator.Check("xbc")).toBe(false);
    expect(siblingValidator.Check("ab")).toBe(false);

    const falseBranch = Compile(convertJsonSchemaToTypeBox({
      allOf: [false, { type: "string" }],
    }));
    expect(falseBranch.Check("anything")).toBe(false);
  });

  it("keeps unsupported schema keywords visible instead of silently dropping them", () => {
    // Intent: unresolved references and definitions cannot be enforced locally, but the model
    // still needs an explicit warning that the permissive schema is incomplete.
    const reference: any = convertJsonSchemaToTypeBox({ $ref: "#/$defs/Person" });
    expect(reference.description).toContain("$ref");
    expect(reference.description).toContain("not enforced");

    const object: any = convertJsonSchemaToTypeBox({
      type: "object",
      $defs: { Color: { type: "string", enum: ["red", "blue"] } },
      properties: { name: { type: "string" } },
    });
    expect(object.type).toBe("object");
    expect(object.description).toContain("$defs");

    const referenceWithSibling = Compile(convertJsonSchemaToTypeBox({
      $ref: "#/$defs/Name",
      type: "string",
      minLength: 3,
    }));
    expect(referenceWithSibling.Check("ab")).toBe(false);
    expect(referenceWithSibling.Check("abc")).toBe(true);
  });

  it("marks prefixItems unsupported while preserving formats and numeric constraints", () => {
    // Intent: prefixItems cannot be safely approximated as a fixed tuple; keep the array
    // permissive with an explicit warning while preserving constraints we can enforce exactly.
    const positional: any = convertJsonSchemaToTypeBox({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: { type: "boolean" },
    });
    const positionalValidator = Compile(positional);
    expect(positional.type).toBe("array");
    expect(positional.description).toContain("prefixItems");
    expect(positional.description).toContain("not enforced");
    expect(positionalValidator.Check([])).toBe(true);
    expect(positionalValidator.Check(["value", 1, "unvalidated tail"])).toBe(true);

    const formatted: any = convertJsonSchemaToTypeBox({ type: "string", format: "email" });
    expect(formatted.format).toBe("email");
    expect(() => Compile(formatted)).not.toThrow();

    const number: any = convertJsonSchemaToTypeBox({
      type: "number",
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
      multipleOf: 0.5,
    });
    expect(number.exclusiveMinimum).toBe(0);
    expect(number.exclusiveMaximum).toBe(100);
    expect(number.multipleOf).toBe(0.5);
  });
});
