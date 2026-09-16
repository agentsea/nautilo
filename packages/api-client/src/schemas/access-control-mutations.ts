/**
 * Stack 195 / W3.2.6 — browser-safe Zod schemas for the preview/apply RBAC
 * mutation endpoints. Slugs/ids are `z.string()` (not enums) so the client
 * tolerates unknown capability/role slugs a newer server may add, matching
 * the existing read-side schema convention. The browser schemas are NOT
 * loosened for untyped data: every field the server contract carries is
 * typed here.
 */
import { z } from "zod";

const stringList = z.array(z.string());

export const accessControlOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role.create"),
    slug: z.string().min(1),
    label: z.string().min(1),
    capabilities: stringList,
  }),
  z.object({
    kind: z.literal("role.rename"),
    roleId: z.string().min(1),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal("role.set_capabilities"),
    roleId: z.string().min(1),
    capabilities: stringList,
  }),
  z.object({
    kind: z.literal("role.delete"),
    roleId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("group.create"),
    groupType: z.string().min(1),
    label: z.string().min(1),
    ownerUserId: z.string().min(1),
    roleSlugs: stringList,
  }),
  z.object({
    kind: z.literal("group.rename"),
    groupId: z.string().min(1),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal("group.set_roles"),
    groupId: z.string().min(1),
    roleSlugs: stringList,
  }),
  z.object({
    kind: z.literal("group.transfer_owner"),
    groupId: z.string().min(1),
    newOwnerUserId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("group.delete"),
    groupId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("membership.add"),
    groupId: z.string().min(1),
    userId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("membership.remove"),
    groupId: z.string().min(1),
    userId: z.string().min(1),
    bypassLastOwner: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("shared_access.create"),
    role: z.object({
      slug: z.string().min(1),
      label: z.string().min(1),
      capabilities: stringList,
    }),
    group: z.object({
      groupType: z.string().min(1),
      label: z.string().min(1),
      ownerUserId: z.string().min(1),
    }),
    memberUserIds: stringList.min(1),
  }),
  z.object({
    kind: z.literal("shared_access.assign_existing"),
    roleSlug: z.string().min(1),
    group: z.object({
      groupType: z.string().min(1),
      label: z.string().min(1),
      ownerUserId: z.string().min(1),
    }),
    memberUserIds: stringList.min(1),
  }),
]);

export const previewRequestBodySchema = z.object({
  operation: accessControlOperationSchema,
});

export const applyRequestBodySchema = z.object({
  operation: accessControlOperationSchema,
  fingerprint: z.string().min(1),
});

export const checkSchema = z.object({
  code: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
  missing: z.array(z.string()).optional(),
});

export const authorityDeltaSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  unchanged: z.array(z.string()),
});

export const affectedUserDeltaSchema = z.object({
  userId: z.string(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  /**
   * True source-aware UNCHANGED capabilities (present in both the before
   * and after effective union). Optional for backward compatibility with
   * older servers that only emitted added/removed.
   */
  unchanged: z.array(z.string()).optional(),
});

export const affectedUserDeltasSchema = z.array(affectedUserDeltaSchema);

export const deletionConsequenceSchema = z.object({
  targetKind: z.enum(["role", "group"]),
  targetId: z.string(),
  targetLabel: z.string(),
  affectedGroups: z
    .array(
      z.object({
        groupId: z.string(),
        groupType: z.string(),
        memberCount: z.number(),
      }),
    )
    .optional(),
  groupRolesRemoved: z.number().optional(),
  roleCapabilitiesRemoved: z.number().optional(),
  membersRemoved: z.number().optional(),
  approvalChallengesRemoved: z.number().optional(),
  roleAssignmentsRemoved: z.number().optional(),
});

export const auditPreviewSchema = z.object({
  kind: z.string(),
  actorId: z.string().nullable(),
}).passthrough();

export const previewResponseSchema = z.object({
  ok: z.boolean(),
  operation: accessControlOperationSchema,
  checks: z.array(checkSchema),
  failures: z.array(checkSchema),
  currentAuthority: z.array(z.string()).optional(),
  proposedAuthority: z.array(z.string()).optional(),
  authorityDelta: authorityDeltaSchema.optional(),
  affectedUserDelta: affectedUserDeltaSchema.optional(),
  /** Canonical plural impact shape for shared edits (W3.2.13). */
  affectedUserDeltas: affectedUserDeltasSchema.optional(),
  deletionConsequence: deletionConsequenceSchema.optional(),
  auditPreview: auditPreviewSchema,
  fingerprint: z.string(),
});

export const applyResponseSchema = z.object({
  applied: z.boolean(),
  auditRecorded: z.boolean().optional(),
  fingerprint: z.string().optional(),
});

export type AccessControlOperation = z.infer<typeof accessControlOperationSchema>;
export type PreviewRequestBody = z.infer<typeof previewRequestBodySchema>;
export type ApplyRequestBody = z.infer<typeof applyRequestBodySchema>;
export type PreviewResponse = z.infer<typeof previewResponseSchema>;
export type ApplyResponse = z.infer<typeof applyResponseSchema>;
export type AccessControlCheck = z.infer<typeof checkSchema>;
export type AuthorityDelta = z.infer<typeof authorityDeltaSchema>;
export type AffectedUserDelta = z.infer<typeof affectedUserDeltaSchema>;
export type AffectedUserDeltas = z.infer<typeof affectedUserDeltasSchema>;
export type DeletionConsequence = z.infer<typeof deletionConsequenceSchema>;
