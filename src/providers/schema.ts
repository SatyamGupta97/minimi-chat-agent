/**
 * Strict structured-output modes (Groq, OpenAI) require every object to be
 * closed and every property listed as required (optional fields are expressed
 * as nullable instead). Converts a zod-generated JSON Schema to that form.
 */
export function strictSchema(schema: unknown): Record<string, unknown> {
  return strictify(schema) as Record<string, unknown>;
}

function strictify(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictify);
  if (!schema || typeof schema !== "object") return schema;
  const s: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) if (k !== "$schema") s[k] = strictify(v);
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    s.additionalProperties = false;
    s.required = Object.keys(s.properties);
  }
  return s;
}
