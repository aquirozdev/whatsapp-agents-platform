import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";
import type { JsonSchema } from "./types.js";

type AjvLike = {
  compile(schema: object): ValidateFunction;
};

const AjvConstructor = AjvModule as unknown as new (options?: Record<string, unknown>) => AjvLike;
const ajv = new AjvConstructor({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
});

const cache = new Map<string, ValidateFunction>();

function schemaKey(schema: JsonSchema): string {
  return JSON.stringify(schema);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "Tool input does not match its schema.";
  return errors
    .slice(0, 5)
    .map((error) => {
      const path = error.instancePath || "/";
      return `${path} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

export function validateToolInput(
  schema: JsonSchema,
  input: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  const key = schemaKey(schema);
  let validate = cache.get(key);
  if (!validate) {
    const compiled = ajv.compile(schema);
    cache.set(key, compiled);
    validate = compiled;
  }

  if (validate(input)) return { ok: true };
  return { ok: false, message: formatErrors(validate.errors) };
}
