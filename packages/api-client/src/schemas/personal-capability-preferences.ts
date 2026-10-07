import { z } from "zod";
import { PERSONAL_CAPABILITY_ROLES } from "@nautilo/types";
import type {
  PersonalCapabilityPreferencesResponse,
  ReplacePersonalCapabilityPreferencesRequest,
} from "@nautilo/types";

const personalCapabilityRoleSchema = z.enum(PERSONAL_CAPABILITY_ROLES);

const personalCapabilityPreferenceOverridesSchema = z
  .object(Object.fromEntries(
    PERSONAL_CAPABILITY_ROLES.map((role) => [
      role,
      z.string().trim().min(1).max(512).optional(),
    ]),
  ) as Record<(typeof PERSONAL_CAPABILITY_ROLES)[number], z.ZodOptional<z.ZodString>>)
  .strict();

const personalCapabilityModelReadinessSchema = z
  .object({
    status: z.enum(["ready", "missing-credentials", "unavailable"]),
    reason: z.string().nullable(),
    fundingSource: z.enum(["personal", "server"]).nullable(),
    providerRoute: z.string().trim().min(1).nullable(),
  })
  .strict();

const personalCapabilityModelOptionSchema = z
  .object({
    modelId: z.string().trim().min(1).max(512),
    displayName: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    readiness: personalCapabilityModelReadinessSchema,
  })
  .strict();

const personalCapabilityPreferenceProjectionSchema = z
  .object({
    role: personalCapabilityRoleSchema,
    label: z.string().trim().min(1),
    description: z.string().trim().min(1),
    selection: z.object({
      source: z.enum(["inherited", "personal"]),
      modelId: z.string().trim().min(1).max(512).nullable(),
      displayName: z.string().trim().min(1),
    }).strict(),
    readiness: personalCapabilityModelReadinessSchema,
    options: z.array(personalCapabilityModelOptionSchema),
  })
  .strict();

export const personalCapabilityPreferencesResponseSchema: z.ZodType<PersonalCapabilityPreferencesResponse> = z
  .object({
    revision: z.number().int().nonnegative(),
    overrides: personalCapabilityPreferenceOverridesSchema,
    fundingPreference: z.enum(["personal_first", "server_first"]),
    capabilities: z.array(personalCapabilityPreferenceProjectionSchema),
  })
  .strict();

export const replacePersonalCapabilityPreferencesRequestSchema: z.ZodType<ReplacePersonalCapabilityPreferencesRequest> = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    overrides: personalCapabilityPreferenceOverridesSchema,
  })
  .strict();
