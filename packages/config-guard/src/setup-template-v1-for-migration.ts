/**
 * Historical parser for the retired setup.toml contract. It otherwise mirrors
 * `packages/api-client/src/schemas/setup-template.ts`, but intentionally retains
 * the deprecated `forcePasswordChangeOnFirstSignIn` key so migration can refuse
 * `true` safely and discard `false` while emitting the current deploy contract.
 * It is duplicated here to avoid a workspace dependency cycle (`api-client`
 * already depends on `config-guard`).
 */
import { z } from "zod";

/** Matches preset files avatar-01..07,09..41 (gap at 08). */
const PresetAvatarId = z.string().regex(
  /^avatar-(0[1-79]|[12]\d|3\d|4[01])$/,
);

export const SecretField = z.union([
  z.object({ value: z.string().min(1) }).strict(),
  z
    .object({
      fromEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    })
    .strict(),
]);

export type SecretField = z.infer<typeof SecretField>;

export const minLengthSecret = (n: number) =>
  SecretField.refine(
    (s) => ("value" in s ? s.value.length >= n : true),
    { message: `value must be ≥ ${n} characters when inlined` },
  );

const GenieAvatarPreset = z
  .object({
    kind: z.literal("preset"),
    presetId: PresetAvatarId,
  })
  .strict();

const GenieAvatarGenerate = z
  .object({
    kind: z.literal("generate"),
    generatePrompt: z.string().min(3).max(500),
  })
  .strict();

const GenieAvatarSkip = z.object({ kind: z.literal("skip") }).strict();

const GenieAvatar = z.discriminatedUnion("kind", [
  GenieAvatarPreset,
  GenieAvatarGenerate,
  GenieAvatarSkip,
]);

const GenieExplicit = z
  .object({
    mode: z.literal("explicit"),
    name: z.string().min(1).max(64),
    voice: z.string().regex(/^[a-z]+:[a-z0-9_-]+$/i),
    defaultModel: z.string().regex(/^[a-z]+:[a-zA-Z0-9.-]+$/),
    personality: z.string().min(1).max(2000),
    avatar: GenieAvatar.optional(),
  })
  .strict();

const GenieRandomize = z
  .object({
    mode: z.literal("randomize"),
    seed: z.number().int().nonnegative().optional(),
    name: z.string().min(1).max(64).optional(),
    voice: z.string().regex(/^[a-z]+:[a-z0-9_-]+$/i).optional(),
    defaultModel: z.string().regex(/^[a-z]+:[a-zA-Z0-9.-]+$/).optional(),
    personality: z.string().min(1).max(2000).optional(),
    avatar: GenieAvatar.optional(),
  })
  .strict();

const GenieSkip = z.object({ mode: z.literal("skip") }).strict();

export const GenieBlock = z.discriminatedUnion("mode", [
  GenieExplicit,
  GenieRandomize,
  GenieSkip,
]);

export const SetupTemplateV1 = z
  .object({
    schemaVersion: z.literal(1),

    serverUrl: z.string().url().optional(),

    admin: z
      .object({
        handle: z.string().min(1).max(128),
        displayName: z.string().min(1).max(256),
        password: minLengthSecret(8),
        pin: SecretField.optional(),
        // Historical input only; this key is absent from the current setup schema.
        forcePasswordChangeOnFirstSignIn: z.boolean().optional(),
      })
      .strict(),

    claim: z
      .object({
        inviteCode: SecretField,
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
