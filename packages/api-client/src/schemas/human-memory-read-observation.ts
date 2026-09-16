import { z } from "zod";
import { MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1 } from
  "@nautilo/lattice-crypto/wire-limits";

/** Same 4 KiB signed acknowledgement carrier as protected history reads.
 * The canonical decoder separately validates its exact fields and signature. */
export const humanMemoryReadObservationRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  acknowledgementBytesBase64url: z.string().min(1).max(Math.ceil(
    MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1 * 4 / 3,
  )).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export const humanMemoryReadObservationResponseV1Schema = z.object({
  status: z.enum(["accepted", "conflict", "unavailable"]),
}).strict();

export type HumanMemoryReadObservationRequestV1 = z.infer<typeof humanMemoryReadObservationRequestV1Schema>;
export type HumanMemoryReadObservationResponseV1 = z.infer<typeof humanMemoryReadObservationResponseV1Schema>;
