import { z } from "zod";

const opaqueId = z.string().min(1).refine(value => value.trim() === value && !/\s/u.test(value) && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
export const magentOriginSchema = z.string().refine(value => {
  try {
    const url = new URL(value);
    return value === url.origin && !url.username && !url.password
      && (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}, "Expected HTTPS or loopback HTTP origin");

/** Operator-only input. Never accept this configuration from a remote message. */
export const magentOperatorConfigSchema = z.object({
  version: z.literal(1), operatorBindingId: z.uuid(), sponsorUserId: z.uuid(), genieId: z.uuid(),
  origin: magentOriginSchema, providerAgentId: opaqueId, chatId: opaqueId, senderId: opaqueId,
  roomName: z.string().trim().min(1), socketPath: z.string().min(1),
  // A dedicated 256-bit-or-stronger random capability, never a Human session token.
  credential: z.string().min(43).regex(/^[A-Za-z0-9_-]+$/u),
  maxRequestBytes: z.number().int().positive().safe(),
}).strict().refine(value => value.senderId !== value.providerAgentId, "Sender must differ from the receiving agent");
export type MagentOperatorConfig = z.infer<typeof magentOperatorConfigSchema>;

/** Attribution only: the fixed connector sender cannot supply local authority or routing. */
export const magentTurnRequestSchema = z.object({
  kind: z.literal("operator_control_v1"),
  sessionId: opaqueId, messageId: opaqueId, senderId: opaqueId, senderLabel: z.string().min(1),
  content: z.string().refine(value => value.trim().length > 0), createdAt: z.iso.datetime({ offset: true }),
}).strict();
export type MagentTurnRequest = z.infer<typeof magentTurnRequestSchema>;
export const magentPublicationClaimSchema = z.object({ claimToken: z.uuid() }).strict();
export const magentPublicationSettlementSchema = z.discriminatedUnion("state", [
  z.object({ claimToken: z.uuid(), state: z.literal("published"), providerMessageId: opaqueId }).strict(),
  z.object({ claimToken: z.uuid(), state: z.enum(["uncertain", "cancelled"]) }).strict(),
]);

/** Private operator manifest; every referenced file retains its own capability. */
export const magentOperatorManifestSchema = z.object({
  version: z.literal(1), configFiles: z.array(z.string().min(1)).min(1),
}).strict();
