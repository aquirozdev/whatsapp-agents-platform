import { describe, expect, it } from "vitest";
import { validateToolInput } from "../src/core/input-validation.js";

describe("validateToolInput", () => {
  const schema = {
    type: "object",
    properties: {
      customerId: { type: "string", minLength: 1 },
      amount: { type: "number", minimum: 0 },
    },
    required: ["customerId"],
    additionalProperties: false,
  };

  it("accepts valid input", () => {
    expect(validateToolInput(schema, { customerId: "c-1", amount: 10 })).toEqual({ ok: true });
  });

  it("rejects missing required properties", () => {
    const result = validateToolInput(schema, { amount: 10 });
    expect(result.ok).toBe(false);
  });

  it("rejects unexpected properties", () => {
    const result = validateToolInput(schema, { customerId: "c-1", admin: true });
    expect(result.ok).toBe(false);
  });
});
