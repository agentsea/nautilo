import { z } from "zod";

export const CliSessionV1 = z.object({
  schemaVersion: z.literal(1),
  instanceId: z.string(),
  serverUrl: z.string().url(),
  handle: z.string(),
  displayName: z.string(),
  // D219 — `serverRole` retired. Role display derives from `actorRole`
  // (highest Group Role slug). Persisted session files written pre-D219
  // still carry `serverRole`; zod ignores the extra field on read.
  // M128 — accept the M128 ladder slugs plus legacy slugs for one
  // release of session-file backwards-compat.
  actorRole: z
    .enum([
      "owner",
      "admin",
      "superuser",
      "member",
      "contributor",
      "community",
      "guest",
      "anonymous",
      "household",
      "teammate",
      "stranger",
    ])
    .optional(),
  externalId: z.string(),
  /** Additive D518 target proof; older HTTP sessions omit it. */
  targetBinding: z
    .object({
      kind: z.enum(["http-origin", "unix-socket"]),
      value: z.string().min(1),
    })
    .optional(),
  /** Exact Logto authority used to mint this refresh token. */
  authBinding: z
    .object({
      flow: z.enum(["browser_loopback", "device"]),
      issuer: z.string().url(),
      clientId: z.string().min(1),
      resource: z.string().min(1),
    })
    .optional(),
  /** Opaque write revision used for compare-and-swap token rotation. */
  revision: z.string().min(1).optional(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  tokenType: z.literal("Bearer"),
  expiresAt: z.number(),
  scopes: z.array(z.string()).default([]),
  source: z.enum(["password", "token", "device"]),
  obtainedAt: z.number(),
});

export type CliSessionV1Payload = z.infer<typeof CliSessionV1>;
