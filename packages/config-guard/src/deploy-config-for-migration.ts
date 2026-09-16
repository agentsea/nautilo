/**
 * KEEP IN SYNC with `packages/deploy-config/src/deploy-schema.ts` (DeployConfigV1).
 * Duplicated here so `@nautilo/config-guard` can validate emitted deploy.toml without
 * depending on `@nautilo/deploy-config` (workspace cycle: deploy-config → config-guard).
 */
import { z } from "zod";
import {
  GenieBlock,
  minLengthSecret,
  SecretField,
} from "./setup-template-v1-for-migration";

export const DeployConfigV1ForMigration = z
  .object({
    schemaVersion: z.literal(1),

    admin: z
      .object({
        handle: z.string().min(1).max(128),
        displayName: z.string().min(1).max(256),
        password: minLengthSecret(8),
        pin: SecretField.optional(),
      })
      .strict(),

    providers: z
      .array(
        z
          .object({
            key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
            value: SecretField,
          })
          .strict(),
      )
      .default([]),

    genie: GenieBlock.optional(),
  })
  .strict();
