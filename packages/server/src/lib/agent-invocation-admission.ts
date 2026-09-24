import type { FastifyReply } from "fastify";
import {
  AgentInvocationDeniedError,
  ServerProviderCredentialsDeniedError,
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  toActionCapabilityHttpDenial,
  type AgentInvocationAdmissionInput,
} from "@nautilo/trust";

export type AssertCanInvokeAgent = (
  input: AgentInvocationAdmissionInput,
) => Promise<void>;

export type AssertServerFunding = (
  humanUserId: string,
  origin?: string,
) => Promise<void>;

export async function requireServerFunding(
  humanUserId: string,
  origin: string,
  reply: FastifyReply,
  assertFunding: AssertServerFunding = assertCanUseServerProviderCredentials,
): Promise<boolean> {
  try {
    await assertFunding(humanUserId, origin);
    return true;
  } catch (error) {
    if (!(error instanceof ServerProviderCredentialsDeniedError)) throw error;
    reply.code(403).send(toActionCapabilityHttpDenial(error));
    return false;
  }
}

/**
 * Apply the canonical current invocation decision and render a known denial as
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
