import { z } from "zod";
import { buildAuthContract, type AuthContract } from "./auth";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a SHA-256 hex digest");

/**
 * Secret-free record of the auth desired-state contract that bootstrap
 * successfully applied. It intentionally contains no instance URLs, IDs, or
 * credentials: those are runtime state, not durable compatibility metadata.
 */
export const appliedAuthContractSchema = z
  .object({
    contractVersion: z.number().int().positive(),
    contractHash: sha256,
    appliedAt: z.string().datetime(),
    logtoEngine: z
      .object({
        image: z.string().min(1),
        minimumVersion: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type AppliedAuthContract = z.infer<typeof appliedAuthContractSchema>;

export function buildAppliedAuthContract(
  appliedAt: string,
  contract: AuthContract = buildAuthContract(),
): AppliedAuthContract {
  return appliedAuthContractSchema.parse({
    contractVersion: contract.version,
    contractHash: contract.hash,
    appliedAt,
    logtoEngine: contract.logtoEngine,
  });
}

export function serializeAppliedAuthContract(
  stamp: AppliedAuthContract,
): string {
  return `${JSON.stringify(stamp, null, 2)}\n`;
}
