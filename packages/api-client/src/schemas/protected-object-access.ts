import { z } from "zod";

const base64url = z.string().min(1).max(349_526)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => value.length % 4 !== 1, {
    message: "signer evidence must be canonical unpadded base64url",
  });

export const protectedObjectAccessSignerEvidenceV1Schema = z.object({
  kind: z.enum(["agent_runtime_publication", "processor_authorization"]),
  evidenceBytesBase64url: base64url,
}).strict();

export const protectedObjectAccessSignerEvidenceSetV1Schema = z.array(
  protectedObjectAccessSignerEvidenceV1Schema,
).max(512).superRefine((entries, context) => {
  const keys = entries.map((entry) =>
    `${entry.kind}:${entry.evidenceBytesBase64url}`
  );
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      message: "protected object signer evidence must be unique",
    });
  }
  if (entries.reduce(
    (total, entry) => total + entry.evidenceBytesBase64url.length,
    0,
  ) > 1_398_102) {
    context.addIssue({
      code: "custom",
      message: "protected object signer evidence exceeds the profile ceiling",
    });
  }
});

export type ProtectedObjectAccessSignerEvidenceV1 = z.infer<
  typeof protectedObjectAccessSignerEvidenceV1Schema
>;
