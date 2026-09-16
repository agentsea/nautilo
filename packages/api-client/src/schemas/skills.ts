import { z } from "zod";

/** Server-owned catalogue item returned by GET /api/skills. */
export const skillCatalogItemSchema = z.object({
  name: z.string(),
  description: z.string(),
});

/** Human-readable, speaker-scoped capability that a Skill may require. */
export const skillToolOptionSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  category: z.string(),
});

export const skillToolOptionsResponseSchema = z.object({
  tools: z.array(skillToolOptionSchema),
});

/** Shared list/detail shape used by the Skills settings surface. */
export const skillListItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  source: z.string(),
  requiresTools: z.array(z.string()),
  tokenEstimate: z.number(),
  updatedAt: z.string(),
  official: z.boolean(),
  forked: z.boolean(),
  version: z.number().optional(),
});

export const skillDetailSchema = skillListItemSchema.extend({
  body: z.string(),
});

export const skillsListResponseSchema = z.object({
  skills: z.array(skillListItemSchema),
  summary: z.object({
    total: z.number(),
    enabled: z.number(),
    disabled: z.number(),
  }),
  catalog: z.array(skillCatalogItemSchema),
});

export const skillDetailResponseSchema = z.object({ skill: skillDetailSchema });
export const skillDeleteResponseSchema = z.object({ ok: z.literal(true) });

export const saveSkillRequestSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  enabled: z.boolean(),
  requiresTools: z.array(z.string()),
});

export const setSkillEnabledRequestSchema = z.object({ enabled: z.boolean() });

export type SkillCatalogItem = z.infer<typeof skillCatalogItemSchema>;
export type SkillToolOption = z.infer<typeof skillToolOptionSchema>;
export type SkillListItem = z.infer<typeof skillListItemSchema>;
export type SkillDetail = z.infer<typeof skillDetailSchema>;
export type SkillsListResponse = z.infer<typeof skillsListResponseSchema>;
export type SaveSkillRequest = z.infer<typeof saveSkillRequestSchema>;
