import { createHash } from "node:crypto";
import { externalMessageOriginSchema } from "@nautilo/types";

/** Loaded through an owner-scoped receipt/binding/session join, never supplied by a client. */
export interface LegacyMagentControlCandidate {
  ownerId: string;
  binding: { id: string; userId: string; connectionId: string; provider: string; origin: string;
    providerAgentId: string; chatId: string; threadId: string; roomId: string; agentId: string };
  connection: { id: string; userId: string; provider: string; transportKind: string };
  receipt: { id: string; userId: string; bindingId: string; providerMessageId: string;
    externalSenderId: string; sessionMessageId: number | null; turnId: string | null; fingerprint: string };
  session: { id: string; ownerId: string; roomId: string | null; agentId: string | null; threadId: string };
  source: { id: number; sessionId: string; role: string; content: unknown; humanTurnId: string | null;
    fingerprint: string | null; metadata: Record<string, unknown> | null };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail closed: JSON shape alone never establishes that a conversation row is control traffic. */
export function verifyLegacyMagentControl(candidate: LegacyMagentControlCandidate): boolean {
  const { ownerId, binding: b, connection: c, receipt: r, session: s, source: m } = candidate;
  if (b.provider !== "magent" || c.provider !== "magent" || c.transportKind !== "operator-unix"
    || b.userId !== ownerId || c.userId !== ownerId || r.userId !== ownerId || s.ownerId !== ownerId
    || b.connectionId !== c.id || r.bindingId !== b.id || r.sessionMessageId !== m.id
    || s.id !== m.sessionId || s.roomId !== b.roomId || s.agentId !== b.agentId
    || s.threadId !== `room:${b.roomId}:bot:${b.agentId}` || m.role !== "user"
    || r.turnId === null || m.humanTurnId !== r.turnId || typeof m.content !== "string"
    || m.metadata?.["externalReceiptId"] !== r.id
    || m.fingerprint !== digest(["external-room-input-v1", r.id])) return false;
  const parsed = externalMessageOriginSchema.safeParse(m.metadata?.["externalOrigin"]);
  if (!parsed.success) return false;
  const o = parsed.data;
  if (o.provider !== "magent" || o.bindingId !== b.id || o.connectionId !== c.id
    || o.origin !== b.origin || o.providerAgentId !== b.providerAgentId || o.chatId !== b.chatId
    || (o.threadRootId ?? "") !== b.threadId || o.messageId !== r.providerMessageId
    || o.senderType !== "anima" || o.senderId !== r.externalSenderId
    || o.senderId !== `magent-connector:${b.providerAgentId}`
    || r.fingerprint !== digest([o.provider, o.origin, o.providerAgentId, o.chatId, o.threadRootId,
      o.messageId, o.senderId, o.senderType, o.createdAt, m.content])) return false;
  let envelope: unknown;
  try { envelope = JSON.parse(m.content); } catch { return false; }
  if (!record(envelope) || Object.keys(envelope).sort().join(",") !== "input,outputSchema,request"
    || typeof envelope["request"] !== "string" || !record(envelope["outputSchema"])
    || !record(envelope["input"])) return false;
  const input = envelope["input"];
  const schema = envelope["outputSchema"];
  return input["roomId"] === b.chatId && input["agentId"] === b.providerAgentId
    && typeof input["sessionId"] === "string" && typeof input["resume"] === "boolean"
    && Array.isArray(input["activity"]) && Array.isArray(input["sources"])
    && schema["type"] === "object" && schema["additionalProperties"] === false
    && record(schema["properties"]) && Array.isArray(schema["required"])
    && (schema["required"] as unknown[]).every(value => typeof value === "string")
    && (schema["required"] as unknown[]).filter((value): value is string => typeof value === "string").sort().join(",") === "action,body,messageIds,notifyAgentIds"
    && digest(input) === r.providerMessageId;
}

/** Only plans archival. A shared room checkpoint must be rebuilt, never deleted wholesale. */
export function planLegacyMagentControlRemediation(candidates: readonly LegacyMagentControlCandidate[], results: readonly LegacyMagentControlResultCandidate[] = []) {
  const sourceMessageIds = new Set<number>();
  const checkpointThreadsToRebuild = new Set<string>();
  for (const candidate of candidates) {
    if (!verifyLegacyMagentControl(candidate)) continue;
    sourceMessageIds.add(candidate.source.id);
    checkpointThreadsToRebuild.add(candidate.session.threadId);
  }
  const resultMessageIds = new Set<number>();
  for (const candidate of results) {
    if (sourceMessageIds.has(candidate.input.source.id) && verifyLegacyMagentControlResult(candidate)) {
      resultMessageIds.add(candidate.result.id);
    }
  }
  return { sourceMessageIds: [...sourceMessageIds], resultMessageIds: [...resultMessageIds], checkpointThreadsToRebuild: [...checkpointThreadsToRebuild] };
}

export interface LegacyMagentControlResultCandidate {
  input: LegacyMagentControlCandidate;
  jobId: string;
  acceptanceId: string;
  outbox: { sourceInboxId: string | null; sessionMessageId: number | null; explicitShareId: string | null; fingerprint: string };
  result: { id: number; sessionId: string; role: string; content: unknown; humanTurnId: string | null;
    replyToMessageId: number | null; fingerprint: string | null; metadata: Record<string, unknown> | null };
}

/** A linked result is archived only together with its verified control request. */
export function verifyLegacyMagentControlResult(candidate: LegacyMagentControlResultCandidate): boolean {
  const { input, outbox, result } = candidate;
  if (!verifyLegacyMagentControl(input) || outbox.sourceInboxId !== input.receipt.id
    || outbox.explicitShareId !== null || outbox.sessionMessageId !== result.id
    || result.sessionId !== input.session.id || result.role !== "assistant" || result.humanTurnId !== null
    || result.replyToMessageId !== input.source.id || typeof result.content !== "string") return false;
  const expected = { kind: "external_room_final_reply_v1", receiptId: input.receipt.id,
    jobId: candidate.jobId, turnId: input.receipt.turnId, acceptanceId: candidate.acceptanceId };
  const final = result.metadata?.["externalFinalReply"];
  if (!record(final) || Object.keys(final).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => final[key] !== value)) return false;
  const fingerprint = digest(["external-room-final-v1", input.receipt.id, candidate.jobId, result.content]);
  return result.fingerprint === fingerprint && outbox.fingerprint === fingerprint;
}
