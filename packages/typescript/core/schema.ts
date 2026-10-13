import { z } from "zod";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
};

/**
 * A Zod schema for one of Handrail's JSON Schemas, for frameworks that take Zod
 * (the AI SDK's `tool()`, LangChain's StructuredTool). Optional fields stay
 * optional; anything this doesn't model (anyOf, oneOf…) is passed through.
 */
export function zodFromJsonSchema(schema: JsonSchema): z.ZodTypeAny {
  const described = (s: z.ZodTypeAny) => (schema.description ? s.describe(schema.description) : s);
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((v) => typeof v === "string")) {
    return described(z.enum(schema.enum as [string, ...string[]]));
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  switch (type) {
    case "string":
      return described(z.string());
    case "integer":
      return described(z.number().int());
    case "number":
      return described(z.number());
    case "boolean":
      return described(z.boolean());
    case "array":
      return described(z.array(schema.items ? zodFromJsonSchema(schema.items) : z.any()));
    case "object":
    case undefined:
      if (schema.properties || type === "object") return described(objectFromJsonSchema(schema));
      return described(z.any());
    default:
      return described(z.any());
  }
}

/** The arguments object of a tool. Extra keys are kept, as Handrail and PayPal may accept them. */
export function objectFromJsonSchema(schema: JsonSchema): z.ZodObject<z.ZodRawShape> {
  const required = new Set(schema.required ?? []);
  const shape: z.ZodRawShape = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const field = zodFromJsonSchema(prop ?? {});
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape).passthrough();
}
