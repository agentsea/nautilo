import { z } from "zod";

export const groupRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  roleSlugs: z.array(z.string()),
});

export const listGroupsResponseSchema = z.object({
  groups: z.array(groupRowSchema),
});

const groupMemberRowSchema = z.object({
  userId: z.string(),
  handle: z.string(),
  displayName: z.string(),
  roleSlug: z.string(),
  groupType: z.string(),
});

export const listGroupMembersResponseSchema = z.object({
  members: z.array(groupMemberRowSchema),
});

export type GroupRow = z.infer<typeof groupRowSchema>;
export type GroupMemberRow = z.infer<typeof groupMemberRowSchema>;
export type ListGroupsResponse = z.infer<typeof listGroupsResponseSchema>;
export type ListGroupMembersResponse = z.infer<typeof listGroupMembersResponseSchema>;
