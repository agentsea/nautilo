import type { FastifyReply } from "fastify";
import {
  AgentInvocationDeniedError,
  assertCanInvokeAgent,
  toActionCapabilityHttpDenial,
  type AgentInvocationAdmissionInput,
} from "@nautilo/trust";

export type AssertCanInvokeAgent = (
  input: AgentInvocationAdmissionInput,
) => Promise<void>;

/**
 * Apply the canonical current-RBAC decision and render only a known absence as
 * the stable 403. Lookup failures remain server errors and create no work.
 */
export async function requireAgentInvocation(
  input: AgentInvocationAdmissionInput,
  reply: FastifyReply,
  assertInvocation: AssertCanInvokeAgent = assertCanInvokeAgent,
): Promise<boolean> {
  try {
    await assertInvocation(input);
    return true;
  } catch (error) {
    if (!(error instanceof AgentInvocationDeniedError)) throw error;
    reply.code(403).send(toActionCapabilityHttpDenial(error));
    return false;
  }
}
