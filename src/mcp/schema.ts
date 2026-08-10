import { Type, type TProperties, type TSchema } from "typebox";

type SharedSchemaOptions = {
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
};

type ObjectSchemaOptions = SharedSchemaOptions & {
  additionalProperties?: boolean | TSchema;
};

const UNSUPPORTED_SCHEMA_KEYWORDS = [
  "$ref",
  "$defs",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "not",
  "patternProperties",
  "propertyNames",
  "contains",
  "prefixItems",
  "uniqueItems",
] as const;

const SCHEMA_METADATA_KEYS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "$defs",
  "$id",
  "$schema",
  "$comment",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSharedSchemaOptions(schema: Record<string, unknown>): SharedSchemaOptions {
  const options: SharedSchemaOptions = {};
  if (typeof schema.title === "string") options.title = schema.title;
  if (typeof schema.description === "string") options.description = schema.description;
  if (Array.isArray(schema.examples)) options.examples = schema.examples;
  if (Object.hasOwn(schema, "default")) options.default = schema.default;
  const unsupported = UNSUPPORTED_SCHEMA_KEYWORDS.filter((keyword) => Object.hasOwn(schema, keyword));
  if (unsupported.length > 0) {
    const note = `Note: ${unsupported.join(", ")} not enforced by pi-base.`;
    options.description = options.description ? `${options.description}\n${note}` : note;
  }
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

export function convertJsonSchemaToTypeBox(schema: unknown): TSchema {
  if (schema === true) return Type.Any();
  if (schema === false) return Type.Never();
  if (!isRecord(schema)) return Type.Any();

  const sharedOptions = readSharedSchemaOptions(schema);

  if (Object.hasOwn(schema, "$ref")) {
    const localSchema = { ...schema };
    delete localSchema.$ref;
    delete localSchema.$defs;
    return hasValidationKeywords(localSchema)
      ? withSharedOptions(convertJsonSchemaToTypeBox(localSchema), sharedOptions)
      : Type.Any(sharedOptions);
  }

  if (schema.const !== undefined) return toLiteralSchema(schema.const, sharedOptions);

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return toUnionSchema(schema.enum.map((value) => toLiteralSchema(value)), sharedOptions);
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const siblingSchema = { ...schema };
    delete siblingSchema.allOf;
    const parts = schema.allOf.map((branch) => convertJsonSchemaToTypeBox(branch));
    if (hasValidationKeywords(siblingSchema)) {
      parts.unshift(convertJsonSchemaToTypeBox(siblingSchema));
    }
    if (parts.length === 1) return withSharedOptions(parts[0]!, sharedOptions);
    return Type.Intersect(parts, sharedOptions);
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return toUnionSchema(schema.anyOf.map((candidate) => convertJsonSchemaToTypeBox(candidate)), sharedOptions);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return toUnionSchema(schema.oneOf.map((candidate) => convertJsonSchemaToTypeBox(candidate)), sharedOptions);
  }

  if (Array.isArray(schema.type) && schema.type.length > 0) {
    const typeValues = schema.type.filter((value): value is string => typeof value === "string");
    if (typeValues.length > 0) {
      return toUnionSchema(typeValues.map((type) => convertJsonSchemaToTypeBox({ ...schema, type })), sharedOptions);
    }
  }

  const schemaType = typeof schema.type === "string"
    ? schema.type
    : (isRecord(schema.properties)
        ? "object"
        : Array.isArray(schema.items)
          || isRecord(schema.items)
          || typeof schema.items === "boolean"
          || Array.isArray(schema.prefixItems)
          ? "array"
          : "any");

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
      return schema.type === undefined && hasValidationKeywords(schema)
        ? Type.Unsafe({ ...schema, ...sharedOptions })
        : Type.Any(sharedOptions);
  }
}

function convertObjectSchema(schema: Record<string, unknown>): TSchema {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
  const mapped: TProperties = {};

  for (const [key, value] of Object.entries(properties)) {
    const converted = convertJsonSchemaToTypeBox(value);
    mapped[key] = required.includes(key) ? converted : Type.Optional(converted);
  }

  const options: ObjectSchemaOptions = readSharedSchemaOptions(schema);
  if (typeof schema.additionalProperties === "boolean") {
    options.additionalProperties = schema.additionalProperties;
  } else if (isRecord(schema.additionalProperties)) {
    options.additionalProperties = convertJsonSchemaToTypeBox(schema.additionalProperties);
  }
  return Type.Object(mapped, options);
}

function convertArraySchema(schema: Record<string, unknown>): TSchema {
  const sharedOptions = readSharedSchemaOptions(schema);
  if (Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0) {
    return Type.Array(Type.Any(), sharedOptions);
  }
  const itemSchema = Array.isArray(schema.items) && schema.items.length > 0
    ? toUnionSchema(schema.items.map((item) => convertJsonSchemaToTypeBox(item)))
    : convertJsonSchemaToTypeBox(schema.items);
  return Type.Array(itemSchema, sharedOptions);
}

function convertStringSchema(schema: Record<string, unknown>): TSchema {
  const options: SharedSchemaOptions & { minLength?: number; maxLength?: number; pattern?: string; format?: string } = {
    ...readSharedSchemaOptions(schema),
  };
  if (typeof schema.minLength === "number") options.minLength = schema.minLength;
  if (typeof schema.maxLength === "number") options.maxLength = schema.maxLength;
  if (typeof schema.pattern === "string") options.pattern = schema.pattern;
  if (typeof schema.format === "string") options.format = schema.format;
  return Type.String(options);
}

function convertNumberSchema(schema: Record<string, unknown>, integer: boolean): TSchema {
  const options: SharedSchemaOptions & {
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
  } = {
    ...readSharedSchemaOptions(schema),
  };
  if (typeof schema.minimum === "number") options.minimum = schema.minimum;
  if (typeof schema.maximum === "number") options.maximum = schema.maximum;
  if (typeof schema.exclusiveMinimum === "number") options.exclusiveMinimum = schema.exclusiveMinimum;
  if (typeof schema.exclusiveMaximum === "number") options.exclusiveMaximum = schema.exclusiveMaximum;
  if (typeof schema.multipleOf === "number") options.multipleOf = schema.multipleOf;
  return integer ? Type.Integer(options) : Type.Number(options);
}

function withSharedOptions(
  schema: TSchema,
  options: SharedSchemaOptions,
): TSchema {
  const schemaDescription = (schema as TSchema & { description?: unknown }).description;
  const currentDescription = typeof schemaDescription === "string" ? schemaDescription : undefined;
  const description = [currentDescription, options.description]
    .filter((value, index, values): value is string =>
      typeof value === "string" && values.indexOf(value) === index)
    .join("\n");
  return {
    ...schema,
    ...options,
    ...(description ? { description } : {}),
  } as TSchema;
}

function hasValidationKeywords(schema: Record<string, unknown>): boolean {
  return Object.keys(schema).some((key) => !SCHEMA_METADATA_KEYS.has(key));
}
