import type { FastifyReply } from "fastify";
import {
  ArtifactWriteDeniedError,
  assertCanWriteArtifacts,
  toActionCapabilityHttpDenial,
  type ArtifactWriteAdmissionInput,
} from "@nautilo/trust";

export type AssertCanWriteArtifacts = (
  input: ArtifactWriteAdmissionInput,
) => Promise<void>;

/**
 * Apply the canonical current-RBAC Artifact-write decision after the caller's
 * existing resource/Namespace visibility checks. Only a known Capability
 * absence maps to the stable 403; lookup failures remain fail-closed 5xx.
 */
export async function requireArtifactWrite(
  input: ArtifactWriteAdmissionInput,
  reply: FastifyReply,
  assertWrite: AssertCanWriteArtifacts = assertCanWriteArtifacts,
): Promise<boolean> {
  try {
    await assertWrite(input);
    return true;
  } catch (error) {
    if (!(error instanceof ArtifactWriteDeniedError)) throw error;
    reply.code(403).send(toActionCapabilityHttpDenial(error));
    return false;
  }
}
