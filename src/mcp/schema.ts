import { Type, type TProperties, type TSchema } from "@sinclair/typebox";

type SharedSchemaOptions = {
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSharedSchemaOptions(schema: Record<string, unknown>): SharedSchemaOptions {
  const options: SharedSchemaOptions = {};
  if (typeof schema.title === "string") options.title = schema.title;
  if (typeof schema.description === "string") options.description = schema.description;
  if (Array.isArray(schema.examples)) options.examples = schema.examples;
  if (Object.hasOwn(schema, "default")) options.default = schema.default;
  return options;
}

function toLiteralSchema(value: unknown, options: SharedSchemaOptions = {}): TSchema {
  if (typeof value === "string") return Type.Literal(value, options);
  if (typeof value === "number") return Number.isInteger(value) ? Type.Literal(value, options) : Type.Literal(value, options);
  if (typeof value === "boolean") return Type.Literal(value, options);
  if (value === null) return Type.Null(options);
  return Type.Any(options);
}

function toUnionSchema(values: TSchema[], options: SharedSchemaOptions = {}): TSchema {
  if (values.length === 0) return Type.Any(options);
  if (values.length === 1) return values[0]!;
  return Type.Union(values, options);
}

export function convertJsonSchemaToTypeBox(schema: Record<string, unknown> | undefined): TSchema {
  if (!isRecord(schema)) return Type.Any();

  const sharedOptions = readSharedSchemaOptions(schema);

  if (schema.const !== undefined) return toLiteralSchema(schema.const, sharedOptions);

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return toUnionSchema(schema.enum.map((value) => toLiteralSchema(value)), sharedOptions);
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return toUnionSchema(schema.anyOf.map((candidate) => convertJsonSchemaToTypeBox(isRecord(candidate) ? candidate : undefined)), sharedOptions);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return toUnionSchema(schema.oneOf.map((candidate) => convertJsonSchemaToTypeBox(isRecord(candidate) ? candidate : undefined)), sharedOptions);
  }

  const schemaType = typeof schema.type === "string"
    ? schema.type
    : (isRecord(schema.properties) ? "object" : Array.isArray(schema.items) || isRecord(schema.items) ? "array" : "any");

  switch (schemaType) {
    case "object":
      return convertObjectSchema(schema);
    case "array":
      return convertArraySchema(schema);
    case "string":
      return convertStringSchema(schema);
    case "number":
      return convertNumberSchema(schema, false);
    case "integer":
      return convertNumberSchema(schema, true);
    case "boolean":
      return Type.Boolean(sharedOptions);
    case "null":
      return Type.Null(sharedOptions);
    default:
      return Type.Any(sharedOptions);
  }
}

function convertObjectSchema(schema: Record<string, unknown>): TSchema {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
  const mapped: TProperties = {};

  for (const [key, value] of Object.entries(properties)) {
    const converted = convertJsonSchemaToTypeBox(isRecord(value) ? value : undefined);
    mapped[key] = required.includes(key) ? converted : Type.Optional(converted);
  }

  return Type.Object(mapped, readSharedSchemaOptions(schema));
}

function convertArraySchema(schema: Record<string, unknown>): TSchema {
  const itemSchema = Array.isArray(schema.items) && schema.items.length > 0
    ? toUnionSchema(schema.items.map((item) => convertJsonSchemaToTypeBox(isRecord(item) ? item : undefined)))
    : convertJsonSchemaToTypeBox(isRecord(schema.items) ? schema.items : undefined);
  return Type.Array(itemSchema, readSharedSchemaOptions(schema));
}

function convertStringSchema(schema: Record<string, unknown>): TSchema {
  const options: SharedSchemaOptions & { minLength?: number; maxLength?: number; pattern?: string } = {
    ...readSharedSchemaOptions(schema),
  };
  if (typeof schema.minLength === "number") options.minLength = schema.minLength;
  if (typeof schema.maxLength === "number") options.maxLength = schema.maxLength;
  if (typeof schema.pattern === "string") options.pattern = schema.pattern;
  return Type.String(options);
}

function convertNumberSchema(schema: Record<string, unknown>, integer: boolean): TSchema {
  const options: SharedSchemaOptions & { minimum?: number; maximum?: number } = {
    ...readSharedSchemaOptions(schema),
  };
  if (typeof schema.minimum === "number") options.minimum = schema.minimum;
  if (typeof schema.maximum === "number") options.maximum = schema.maximum;
  return integer ? Type.Integer(options) : Type.Number(options);
}
