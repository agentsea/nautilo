import { z } from "zod";
import {
  GenieBlock,
  minLengthSecret,
  SecretField,
} from "@nautilo/api-client";

export const DeployConfigV1 = z
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

export type DeployConfig = z.infer<typeof DeployConfigV1>;
