/**
 * Stack 195 / W3.1.2 — browser-safe Zod schemas for the read-only
 * access-control endpoints.
 *
 * Slugs are `z.string()` (not enums) so the client tolerates unknown
 * capability/role slugs a newer server may add, matching the existing
 * `whoamiResponseSchema` convention (M129 §2.3). Consumers filter with
 * `isCapabilitySlug` when they need the canonical union.
 */
import { z } from "zod";

export const accessControlProvenancePathSchema = z.object({
  groupId: z.string(),
  groupType: z.string(),
  groupLabel: z.string(),
  groupIsSystem: z.boolean(),
  groupOwnerId: z.string().nullable(),
  roleSlug: z.string(),
  roleLabel: z.string(),
  roleIsSystem: z.boolean(),
});

export const accessControlCapabilityRowSchema = z.object({
  slug: z.string(),
  description: z.string(),
  category: z.string(),
  granted: z.boolean(),
  provenance: z.array(accessControlProvenancePathSchema).readonly(),
});

export const accessControlGroupSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  isSystem: z.boolean(),
  ownerId: z.string().nullable(),
  roleSlugs: z.array(z.string()).readonly(),
});

export const accessControlRoleSummarySchema = z.object({
  slug: z.string(),
  label: z.string(),
  isSystem: z.boolean(),
  capabilitySlugs: z.array(z.string()).readonly(),
});

export const accessControlUserIdentitySchema = z.object({
  id: z.string(),
  handle: z.string().nullable(),
  displayName: z.string(),
  server: z.string().nullable(),
});

export const accessControlGroupRoleFactSchema = z.object({
  groupId: z.string(),
  groupType: z.string(),
  groupLabel: z.string(),
  groupIsSystem: z.boolean(),
  groupOwnerId: z.string().nullable(),
  roleSlug: z.string(),
  roleLabel: z.string(),
  roleIsSystem: z.boolean(),
  capabilitySlugs: z.array(z.string()).readonly(),
});

export const effectiveAccessResponseSchema = z.object({
  user: accessControlUserIdentitySchema,
  highestRole: z.string().nullable(),
  capabilities: z.array(accessControlCapabilityRowSchema).readonly(),
  groups: z.array(accessControlGroupSummarySchema).readonly(),
  roles: z.array(accessControlRoleSummarySchema).readonly(),
  groupRoleFacts: z.array(accessControlGroupRoleFactSchema).readonly(),
});

export const catalogueCapabilitySchema = z.object({
  slug: z.string(),
  description: z.string(),
  category: z.string(),
});

export const catalogueRoleSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  label: z.string(),
  isSystem: z.boolean(),
  capabilitySlugs: z.array(z.string()).readonly(),
  groupCount: z.number(),
});

export const catalogueGroupSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  isSystem: z.boolean(),
  ownerId: z.string().nullable(),
  roleSlugs: z.array(z.string()).readonly(),
  memberCount: z.number(),
});

export const accessControlCatalogueSchema = z.object({
  capabilities: z.array(catalogueCapabilitySchema).readonly(),
  roles: z.array(catalogueRoleSummarySchema).readonly(),
  groups: z.array(catalogueGroupSummarySchema).readonly(),
});

/**
 * Stack 195 / W3.2 — minimal Human directory row for Access Control
 * owner/member selection. Only the three safe selection fields; the
 * server never includes email, external IDs, capability bundles,
 * disabled/offboard metadata, tokens, or secrets on this endpoint.
 */
export const accessControlHumanRowSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  handle: z.string().nullable(),
});

export const accessControlHumanListSchema = z.array(accessControlHumanRowSchema).readonly();

export type AccessControlProvenancePath = z.infer<
  typeof accessControlProvenancePathSchema
>;
export type AccessControlCapabilityRow = z.infer<
  typeof accessControlCapabilityRowSchema
>;
export type AccessControlGroupSummary = z.infer<
  typeof accessControlGroupSummarySchema
>;
export type AccessControlRoleSummary = z.infer<
  typeof accessControlRoleSummarySchema
>;
export type AccessControlUserIdentity = z.infer<
  typeof accessControlUserIdentitySchema
>;
export type AccessControlGroupRoleFact = z.infer<
  typeof accessControlGroupRoleFactSchema
>;
export type EffectiveAccessResponse = z.infer<typeof effectiveAccessResponseSchema>;
export type CatalogueCapability = z.infer<typeof catalogueCapabilitySchema>;
export type CatalogueRoleSummary = z.infer<typeof catalogueRoleSummarySchema>;
export type CatalogueGroupSummary = z.infer<typeof catalogueGroupSummarySchema>;
export type AccessControlCatalogue = z.infer<typeof accessControlCatalogueSchema>;
export type AccessControlHumanRow = z.infer<typeof accessControlHumanRowSchema>;
export type AccessControlHumanList = z.infer<typeof accessControlHumanListSchema>;
