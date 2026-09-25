import type { ConversationState, ToolBinding, VerificationLevel } from "./types.js";
import { getPath } from "./template.js";

function policyError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export class PolicyEngine {
  assertToolAllowed(
    binding: ToolBinding,
    state: ConversationState,
    input: Record<string, unknown> = {},
    nowEpochSeconds = Math.floor(Date.now() / 1000),
  ): void {
    const required = binding.requiresVerification ?? "none";
    if (required !== "none" && !this.hasVerification(state, required, nowEpochSeconds)) {
      throw policyError("VERIFICATION_REQUIRED", `Tool ${binding.name} requires ${required} verification.`);
    }

    if (required !== "none" && binding.verificationSubjectFrom) {
      const expected = getPath(input, binding.verificationSubjectFrom);
      if (expected === undefined || expected === null || String(expected).trim() === "") {
        throw policyError(
          "VERIFICATION_SUBJECT_MISSING",
          `Tool ${binding.name} requires a verification subject at ${binding.verificationSubjectFrom}.`,
        );
      }
      if (!state.verification.subjectId || state.verification.subjectId !== String(expected)) {
        throw policyError(
          "VERIFICATION_SUBJECT_MISMATCH",
          `Tool ${binding.name} verification does not match the requested subject.`,
        );
      }
    }
  }

  hasVerification(
    state: ConversationState,
    level: VerificationLevel,
    nowEpochSeconds = Math.floor(Date.now() / 1000),
  ): boolean {
    if (level === "none") return true;
    return state.verification.level === level && (state.verification.expiresAt ?? 0) > nowEpochSeconds;
  }
}
