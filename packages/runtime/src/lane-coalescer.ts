import type {
  ChatMultimodalImagePart,
  ActiveMiniAppRequestContext,
  ChatArtifactRef,
  FocusedResourceToolTarget,
  ResolvedFocusedResource,
  TrustedLiveMiniAppSessionContext,
  VerifiedOrdinaryOrigin,
} from "@nautilo/types";
import { parseLiveDocumentVersion } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

export function parseActiveMiniAppInput(raw: unknown): ActiveMiniAppRequestContext | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["appId"] !== "string" || !obj["appId"]) return null;
  if (typeof obj["updatedAt"] !== "number" || !Number.isFinite(obj["updatedAt"])) return null;
  return raw as ActiveMiniAppRequestContext;
}

export function parseTrustedLiveMiniAppSessionInput(
  raw: unknown,
): TrustedLiveMiniAppSessionContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const documentVersion = parseLiveDocumentVersion(value["documentVersion"]);
  return (
    typeof value["appId"] === "string" &&
    typeof value["sessionToken"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["instructions"] === "string" &&
    documentVersion !== null
  )
    ? ({
        appId: value["appId"],
        sessionToken: value["sessionToken"],
        sessionId: value["sessionId"],
        instructions: value["instructions"],
        documentVersion,
      } satisfies TrustedLiveMiniAppSessionContext)
    : null;
}

/**
 * D356 — parse a job-input `artifactRefs` array into validated `ChatArtifactRef`s.
 * Already resolved+validated server-side (see `messaging/artifact-refs.ts`);
 * this is the runtime-side shape guard when rehydrating a job payload.
 */
export function parseArtifactRefsInput(raw: unknown): ChatArtifactRef[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatArtifactRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o["artifactId"] !== "string" || !o["artifactId"]) continue;
    if (typeof o["path"] !== "string") continue;
    if (typeof o["mimeType"] !== "string") continue;
    if (typeof o["size"] !== "number" || !Number.isFinite(o["size"])) continue;
    out.push({
      artifactId: o["artifactId"],
      path: o["path"],
      mimeType: o["mimeType"],
      size: o["size"],
    });
  }
  return out;
}

/** D356 — union artifact refs across coalesced burst segments, dedupe by id. */
function mergeArtifactRefs(
  inputs: readonly { artifactRefs?: ChatArtifactRef[] }[],
): ChatArtifactRef[] {
  const seen = new Set<string>();
  const merged: ChatArtifactRef[] = [];
  for (const i of inputs) {
    for (const ref of i.artifactRefs ?? []) {
      if (seen.has(ref.artifactId)) continue;
      seen.add(ref.artifactId);
      merged.push(ref);
    }
  }
  return merged;
}

/**
 * D423 — parse a job-input `focusedResources` array (the server-resolved
 * `ResolvedFocusedResource[]` manifest) into validated entries. Already
 * resolved+validated server-side (see `messaging/focused-resources.ts`); this
 * is the runtime-side shape guard when rehydrating a job payload. Private
 * `locator` is carried through opaquely (never rendered by the prompt block).
 */
export function parseFocusedResourcesInput(raw: unknown): ResolvedFocusedResource[] {
  if (!Array.isArray(raw)) return [];
  const out: ResolvedFocusedResource[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (kind !== "workspace-artifact" && kind !== "local-file" && kind !== "message-attachment") {
      continue;
    }
    if (typeof o["displayName"] !== "string" || !o["displayName"]) continue;
    if (o["location"] !== "server" && o["location"] !== "relay") continue;
    if (o["lifetime"] !== "turn" && o["lifetime"] !== "message" && o["lifetime"] !== "workspace") {
      continue;
    }
    if (!Array.isArray(o["capabilities"])) continue;
    const capabilities = (o["capabilities"] as unknown[]).filter(
      (c): c is ResolvedFocusedResource["capabilities"][number] =>
        c === "read" ||
        c === "edit" ||
        c === "convert" ||
        c === "transcribe" ||
        c === "extract-audio" ||
        c === "share",
    );
    const resource: ResolvedFocusedResource = {
      kind,
      displayName: o["displayName"],
      location: o["location"],
      lifetime: o["lifetime"],
      capabilities,
      locator: o["locator"],
      ...(typeof o["mimeType"] === "string" && o["mimeType"] ? { mimeType: o["mimeType"] } : {}),
      ...(typeof o["size"] === "number" && Number.isFinite(o["size"]) ? { size: o["size"] } : {}),
      ...(isFocusedToolTarget(o["toolTarget"]) ? { toolTarget: o["toolTarget"] } : {}),
    };
    out.push(resource);
  }
  return out;
}

function isFocusedToolTarget(value: unknown): value is FocusedResourceToolTarget {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v["tool"] !== "file") return false;
  if (v["zone"] !== "workspace" && v["zone"] !== "current" && v["zone"] !== "absolute") return false;
  return typeof v["path"] === "string";
}

/**
 * D423 — kind-specific stable dedupe key for a resolved manifest entry. Mirrors
 * the server-side `resolvedFocusedResourceDedupeKey` so coalesced burst segments
 * collapse duplicate resources into one manifest entry.
 */
function focusedResourceDedupeKey(resource: ResolvedFocusedResource): string {
  if (resource.kind === "workspace-artifact") {
    const locator = resource.locator as { artifactId?: string } | string | undefined;
    const artifactId =
      typeof locator === "string" ? locator : (locator?.artifactId ?? "");
    return `workspace-artifact:${artifactId}`;
  }
  if (resource.kind === "message-attachment") {
    const locator = resource.locator as { attachmentId?: string } | string | undefined;
    const attachmentId =
      typeof locator === "string" ? locator : (locator?.attachmentId ?? "");
    return `message-attachment:${attachmentId}`;
  }
  const locator = resource.locator as { relayId?: string; path?: string } | undefined;
  return `local-file:${locator?.relayId ?? ""}:${locator?.path ?? ""}`;
}

/** D423 — union resolved focused resources across burst segments, kind-specific dedupe. */
function mergeFocusedResources(
  inputs: readonly { focusedResources?: ResolvedFocusedResource[] }[],
): ResolvedFocusedResource[] {
  const seen = new Set<string>();
  const merged: ResolvedFocusedResource[] = [];
  for (const i of inputs) {
    for (const resource of i.focusedResources ?? []) {
      const key = focusedResourceDedupeKey(resource);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(resource);
    }
  }
  return merged;
}

export interface CoalescedInput {
  message: string;
  attachmentTextBlocks: string[];
  multimodalImages: ChatMultimodalImagePart[];
  /**
   * D391 — attachment ids (retained images/audio) uploaded with this turn.
   * Threaded to the executor so `persistMessages` can stamp `turn_id` (= the
   * human message fingerprint) on them once the human row is persisted → they
   * render from room history. Unioned (dedupe) across coalesced segments, which
   * merge into a single human row/fingerprint.
   */
  retainedAttachmentIds?: string[];
  ownerId: string;
  requestorId: string;
  /** M233 — authenticated initiating Human for supported assistant output. */
  causalHumanUserId?: string;
  /** M233 — union of picker-authored Human recipients across burst segments. */
  mentionedHumanUserIds?: string[];
  /** Structured Room-wide Human mention intent; true wins across a burst. */
  mentionEveryone?: boolean;
  agentId: string;
  roomId: string;
  graphThreadId: string;
  laneKey: string;
  voiceMode: boolean;
  /** Ephemeral approval posture; latest segment wins on coalesce. */
  autoApprove?: boolean;
  turnId: string;
  memoryAccessEnvelope?: MemoryAccessEnvelope;
  actorRole: string;
  /**
   * Host authority is one coherent snapshot with currentFolder.  Coalescing
   * keeps the first segment's snapshot (like currentFolder) and never joins
   * a later relay/origin to an earlier folder.
   */
  currentFolder: string | null;
  currentFolderRelayId?: string | null;
  verifiedOrdinaryOrigin?: VerifiedOrdinaryOrigin | null;
  workspacePath: string | null;
  activeMiniApp: ActiveMiniAppRequestContext | null;
  liveMiniAppSession?: TrustedLiveMiniAppSessionContext | null;
  /** D356 — turn-scoped artifact references; unioned (dedupe by id) on coalesce. */
  artifactRefs?: ChatArtifactRef[];
  /**
   * D423 Phase 4 — server-resolved focused-resource manifest (workspace
   * artifact / local file / message attachment). Unioned (kind-specific
   * dedupe) on coalesce. Private `locator` is carried opaquely; pre-model
   * renders ONE `## Focused resources` block from the public fields only.
   */
  focusedResources?: ResolvedFocusedResource[];
  securityAuditIp: string;
  securityAuditUserAgent: string;
  threadId: string;
  roomRoster: unknown[];
  /** D124 — last segment wins when bursts coalesce. */
  replyToMessageId?: number | null;
  /** D302 P4 — wake against an already-persisted human row (skip re-persist). */
  humanAlreadyPersisted?: boolean;
  /** Keys from the original job payload not in the schema above (merged last-wins). Tests + rare forwards. */
  passthrough?: Record<string, unknown>;
}

interface BufferEntry {
  inputs: CoalescedInput[];
  inputVirtualIds: string[][];
  flushTimer: ReturnType<typeof setTimeout> | null;
  virtualJobIds: string[];
}

export class LaneCoalescer {
  private buffers = new Map<string, BufferEntry>();
  /** Sliding silence between appends after the first segment (Spacebot-style burst window). */
  private readonly windowMs: number;
  /**
   * Deadline for the **first** segment only — matches Spacebot-style debounce (~1.5s)
   * for a lone send; rapid follow-ups switch to `windowMs`.
   */
  private readonly firstSegmentQuietMs: number;

  constructor(
    private readonly setTimer: typeof setTimeout,
    private readonly clearTimer: typeof clearTimeout,
    private readonly onFlush: (
      laneKey: string,
      merged: CoalescedInput,
      virtualIds: readonly string[],
    ) => void,
    windowMs?: number,
    firstSegmentQuietMs?: number,
  ) {
    this.windowMs = windowMs ?? 2_000;
    this.firstSegmentQuietMs =
      firstSegmentQuietMs ?? Math.min(1_500, this.windowMs);
  }

  enqueue(input: CoalescedInput, virtualJobId: string): void {
    const existing = this.buffers.get(input.laneKey);
    if (!existing) {
      const entry: BufferEntry = {
        inputs: [input],
        inputVirtualIds: [[virtualJobId]],
        flushTimer: this.setTimer(() => {
          this.flush(input.laneKey);
        }, this.firstSegmentQuietMs),
        virtualJobIds: [virtualJobId],
      };
      this.buffers.set(input.laneKey, entry);
      return;
    }
    if (existing.flushTimer) this.clearTimer(existing.flushTimer);
    existing.inputs.push(input);
    existing.inputVirtualIds.push([virtualJobId]);
    existing.virtualJobIds.push(virtualJobId);
    existing.flushTimer = this.setTimer(() => {
      this.flush(input.laneKey);
    }, this.windowMs);
  }

  rebufferMergedAfterRace(
    laneKey: string,
    merged: CoalescedInput,
    virtualJobIds: readonly string[],
  ): void {
    const existing = this.buffers.get(laneKey);
    if (existing?.flushTimer) this.clearTimer(existing.flushTimer);
    const entry: BufferEntry = {
      inputs: [merged],
      inputVirtualIds: [[...virtualJobIds]],
      flushTimer: this.setTimer(() => {
        this.flush(laneKey);
      }, this.windowMs),
      virtualJobIds: [...virtualJobIds],
    };
    this.buffers.set(laneKey, entry);
  }

  flushIfPending(laneKey: string): void {
    if (this.buffers.has(laneKey)) this.flush(laneKey);
  }

  /**
   * Takes pending buffered segments without invoking `onFlush` (tests / introspection).
   */
  drainLane(laneKey: string): { merged: CoalescedInput; virtualJobIds: string[] } | null {
    const entry = this.buffers.get(laneKey);
    if (!entry) return null;
    if (entry.flushTimer) this.clearTimer(entry.flushTimer);
    this.buffers.delete(laneKey);
    return {
      merged: mergeInputs(entry.inputs),
      virtualJobIds: [...entry.virtualJobIds],
    };
  }

  dropLane(laneKey: string): boolean {
    return this.consumeLane(laneKey) !== null;
  }

  /**
   * D420 (Wave 2 task 2.2.3) — drop a buffered lane and return its virtual job
   * ids so the runtime can durably terminalize their mapped acceptances as
   * `user_cancelled` on a D349 user Stop (R8). Returns `null` when the lane is
   * not buffered (idempotent against a double drop). Mirrors {@link dropLane}
   * but surfaces the identity the ledger needs instead of a bare boolean.
   */
  dropLaneVirtualIds(laneKey: string): string[] | null {
    return this.consumeLane(laneKey);
  }

  /** Remove exact accepted segments without dropping later sends on the lane. */
  removeVirtualJobs(ids: ReadonlySet<string>): string[] {
    const emptied: string[] = [];
    for (const [lane, entry] of this.buffers) {
      for (let i = entry.inputs.length - 1; i >= 0; i -= 1) {
        // A rebuffered merged segment is indivisible. Never drop a segment
        // containing a newer acceptance that was not selected for removal.
        if (entry.inputVirtualIds[i]!.every(id => ids.has(id))) {
          entry.inputs.splice(i, 1);
          entry.inputVirtualIds.splice(i, 1);
        }
      }
      entry.virtualJobIds = entry.inputVirtualIds.flat();
      if (entry.inputs.length === 0) {
        this.consumeLane(lane);
        emptied.push(lane);
      }
    }
    return emptied;
  }

  private consumeLane(laneKey: string): string[] | null {
    const entry = this.buffers.get(laneKey);
    if (!entry) return null;
    if (entry.flushTimer) this.clearTimer(entry.flushTimer);
    this.buffers.delete(laneKey);
    return [...entry.virtualJobIds];
  }

  dropLanesForRoom(roomId: string): { lanes: number; virtualJobIds: string[] } {
    const prefix = `room:${roomId}:`;
    let lanes = 0;
    const virtualJobIds: string[] = [];
    for (const laneKey of [...this.buffers.keys()]) {
      if (laneKey.startsWith(prefix)) {
        const vids = this.consumeLane(laneKey);
        if (vids) {
          lanes += 1;
          virtualJobIds.push(...vids);
        }
      }
    }
    return { lanes, virtualJobIds };
  }

  /** Number of lanes with unflushed, committed user intent. */
  getBufferedLaneCount(): number {
    return this.buffers.size;
  }

  /** Drop all unflushed intent, returning the number of affected lanes. */
  dropAllLanes(): number {
    let dropped = 0;
    for (const laneKey of [...this.buffers.keys()]) {
      if (this.dropLane(laneKey)) dropped += 1;
    }
    return dropped;
  }

  private flush(laneKey: string): void {
    const entry = this.buffers.get(laneKey);
    if (!entry) return;
    if (entry.flushTimer) this.clearTimer(entry.flushTimer);
    this.buffers.delete(laneKey);
    const merged = mergeInputs(entry.inputs);
    this.onFlush(laneKey, merged, entry.virtualJobIds);
  }
}

export function mergeInputs(inputs: readonly CoalescedInput[]): CoalescedInput {
  const first = inputs[0]!;
  if (inputs.length === 1) return first;
  const { replyToMessageId: _dropReply, ...firstBase } = first;
  const message = inputs.map((i) => i.message).join("\n\n");
  const attachmentTextBlocks = inputs.flatMap((i) => i.attachmentTextBlocks);
  const seen = new Set<string>();
  const multimodalImages: ChatMultimodalImagePart[] = [];
  for (const i of inputs) {
    for (const part of i.multimodalImages) {
      if (!seen.has(part.attachmentId)) {
        seen.add(part.attachmentId);
        multimodalImages.push(part);
      }
    }
  }
  let mergedPass: Record<string, unknown> | undefined;
  let lastReplyTo: number | undefined;
  for (const i of inputs) {
    if (typeof i.replyToMessageId === "number") lastReplyTo = i.replyToMessageId;
    if (i.passthrough && Object.keys(i.passthrough).length > 0) {
      mergedPass = { ...mergedPass, ...i.passthrough };
    }
  }
  // Already-persisted wakes retain every canonical source, rather than the
  // final passthrough currentMessageId replacing the earlier Human evidence.
  const memoryReviewSourceMessageIds = [...new Set(inputs.flatMap((input) => {
    const explicit = input.passthrough?.["memoryReviewSourceMessageIds"];
    const current = input.passthrough?.["currentMessageId"];
    const supplied: unknown[] = Array.isArray(explicit) ? explicit as unknown[] : [];
    return [...supplied, ...(typeof current === "number" ? [current] : [])]
      .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0);
  }))];
  if (memoryReviewSourceMessageIds.length) mergedPass = { ...mergedPass, memoryReviewSourceMessageIds };
  const artifactRefs = mergeArtifactRefs(inputs);
  const focusedResources = mergeFocusedResources(inputs);
  // D391 — union retained attachment ids across coalesced segments (dedupe).
  // The segments merge into ONE human row, so all ids stamp that one fingerprint.
  const retainedAttachmentIds = Array.from(
    new Set(inputs.flatMap((i) => i.retainedAttachmentIds ?? [])),
  );
  const mentionedHumanUserIds = Array.from(
    new Set(inputs.flatMap((i) => i.mentionedHumanUserIds ?? [])),
  );
  const mentionEveryone = inputs.some((input) => input.mentionEveryone === true);
  const last = inputs[inputs.length - 1]!;
  return {
    ...firstBase,
    message,
    attachmentTextBlocks,
    multimodalImages,
    ...(retainedAttachmentIds.length > 0 ? { retainedAttachmentIds } : {}),
    ...(mentionedHumanUserIds.length > 0 ? { mentionedHumanUserIds } : {}),
    ...(mentionEveryone ? { mentionEveryone: true } : {}),
    artifactRefs,
    focusedResources,
    autoApprove: last.autoApprove === true,
    ...(lastReplyTo !== undefined ? { replyToMessageId: lastReplyTo } : {}),
    ...(mergedPass && Object.keys(mergedPass).length > 0 ? { passthrough: mergedPass } : {}),
  };
}

const JOB_INPUT_SCHEMA_KEYS = new Set([
  "message",
  "attachmentTextBlocks",
  "multimodalImages",
  "retainedAttachmentIds",
  "ownerId",
  "requestorId",
  "causalHumanUserId",
  "mentionedHumanUserIds",
  "mentionEveryone",
  "agentId",
  "roomId",
  "graphThreadId",
  "laneKey",
  "voiceMode",
  "autoApprove",
  "turnId",
  "memoryAccessEnvelope",
  "actorRole",
  "currentFolder",
  "currentFolderRelayId",
  "verifiedOrdinaryOrigin",
  "workspacePath",
  "activeMiniApp",
  "liveMiniAppSession",
  "artifactRefs",
  "focusedResources",
  "securityAuditIp",
  "securityAuditUserAgent",
  "threadId",
  "roomRoster",
  "forkRun",
  "replyToMessageId",
  "humanAlreadyPersisted",
]);

export function jobInputToCoalescedInput(
  input: Record<string, unknown>,
  laneKey: string,
  ownerId: string,
  requestorId: string,
): CoalescedInput {
  const message = typeof input["message"] === "string" ? input["message"] : "";
  const attachmentTextBlocks = Array.isArray(input["attachmentTextBlocks"])
    ? input["attachmentTextBlocks"].filter((x): x is string => typeof x === "string")
    : [];
  const multimodalImages = Array.isArray(input["multimodalImages"])
    ? (input["multimodalImages"] as ChatMultimodalImagePart[])
    : [];
  const retainedAttachmentIds = Array.isArray(input["retainedAttachmentIds"])
    ? input["retainedAttachmentIds"].filter((x): x is string => typeof x === "string")
    : [];
  const ownerIdResolved =
    typeof input["ownerId"] === "string" && input["ownerId"]
      ? input["ownerId"]
      : ownerId;
  const requestorIdResolved =
    typeof input["requestorId"] === "string" && input["requestorId"]
      ? input["requestorId"]
      : requestorId;
  const causalHumanUserId =
    typeof input["causalHumanUserId"] === "string" && input["causalHumanUserId"]
      ? input["causalHumanUserId"]
      : undefined;
  const mentionedHumanUserIds = Array.isArray(input["mentionedHumanUserIds"])
    ? input["mentionedHumanUserIds"].filter((value): value is string =>
        typeof value === "string"
      )
    : [];
  const mentionEveryone = input["mentionEveryone"] === true;
  const agentId = typeof input["agentId"] === "string" ? input["agentId"] : "";
  const roomId = typeof input["roomId"] === "string" ? input["roomId"] : "";
  const graphThreadId =
    typeof input["graphThreadId"] === "string" ? input["graphThreadId"] : laneKey;
  const threadId = typeof input["threadId"] === "string" ? input["threadId"] : graphThreadId;
  const voiceMode = input["voiceMode"] === true;
  const autoApprove = input["autoApprove"] === true;
  const turnId = typeof input["turnId"] === "string" ? input["turnId"] : "";
  const actorRole = typeof input["actorRole"] === "string" ? input["actorRole"] : "guest";
  const currentFolder =
    input["currentFolder"] === null || typeof input["currentFolder"] === "string"
      ? input["currentFolder"]
      : null;
  const currentFolderRelayId =
    input["currentFolderRelayId"] === null || typeof input["currentFolderRelayId"] === "string"
      ? input["currentFolderRelayId"]
      : null;
  // Transport only. Both foreground executors strictly validate this before
  // it can become graph/host authority.
  const verifiedOrdinaryOrigin =
    input["verifiedOrdinaryOrigin"] && typeof input["verifiedOrdinaryOrigin"] === "object"
      ? input["verifiedOrdinaryOrigin"] as VerifiedOrdinaryOrigin
      : null;
  const workspacePath =
    input["workspacePath"] === null || typeof input["workspacePath"] === "string"
      ? input["workspacePath"]
      : null;
  const activeMiniApp = parseActiveMiniAppInput(input["activeMiniApp"]);
  const liveMiniAppSession = parseTrustedLiveMiniAppSessionInput(input["liveMiniAppSession"]);
  const artifactRefs = parseArtifactRefsInput(input["artifactRefs"]);
  const focusedResources = parseFocusedResourcesInput(input["focusedResources"]);
  const securityAuditIp =
    typeof input["securityAuditIp"] === "string" ? input["securityAuditIp"] : "";
  const securityAuditUserAgent =
    typeof input["securityAuditUserAgent"] === "string"
      ? input["securityAuditUserAgent"]
      : "";
  const roomRoster = Array.isArray(input["roomRoster"]) ? input["roomRoster"] : [];
  const replyToRaw = input["replyToMessageId"];
  const replyToMessageId =
    typeof replyToRaw === "number" && Number.isInteger(replyToRaw) ? replyToRaw
    : replyToRaw === null ? null
    : undefined;
  const humanAlreadyPersisted = input["humanAlreadyPersisted"] === true;
  const memoryAccessEnvelope = input["memoryAccessEnvelope"] as
    | MemoryAccessEnvelope
    | undefined;

  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!JOB_INPUT_SCHEMA_KEYS.has(k)) passthrough[k] = v;
  }

  const core: CoalescedInput = {
    message,
    attachmentTextBlocks,
    multimodalImages,
    ...(retainedAttachmentIds.length > 0 ? { retainedAttachmentIds } : {}),
    ownerId: ownerIdResolved,
    requestorId: requestorIdResolved,
    ...(causalHumanUserId ? { causalHumanUserId } : {}),
    ...(mentionedHumanUserIds.length > 0 ? { mentionedHumanUserIds } : {}),
    ...(mentionEveryone ? { mentionEveryone: true } : {}),
    agentId,
    roomId,
    graphThreadId,
    laneKey,
    voiceMode,
    autoApprove,
    turnId,
    ...(memoryAccessEnvelope !== undefined ? { memoryAccessEnvelope } : {}),
    actorRole,
    currentFolder,
    currentFolderRelayId,
    verifiedOrdinaryOrigin,
    workspacePath,
    activeMiniApp,
    liveMiniAppSession,
    artifactRefs,
    focusedResources,
    securityAuditIp,
    securityAuditUserAgent,
    threadId,
    roomRoster,
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    ...(humanAlreadyPersisted ? { humanAlreadyPersisted: true } : {}),
  };

  return Object.keys(passthrough).length > 0 ? { ...core, passthrough } : core;
}

export function coalescedInputToJobInput(c: CoalescedInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    message: c.message,
    attachmentTextBlocks: c.attachmentTextBlocks,
    multimodalImages: c.multimodalImages,
    ...(c.retainedAttachmentIds && c.retainedAttachmentIds.length > 0
      ? { retainedAttachmentIds: c.retainedAttachmentIds }
      : {}),
    ownerId: c.ownerId,
    ...(c.causalHumanUserId
      ? { causalHumanUserId: c.causalHumanUserId }
      : {}),
    ...(c.mentionedHumanUserIds && c.mentionedHumanUserIds.length > 0
      ? { mentionedHumanUserIds: c.mentionedHumanUserIds }
      : {}),
    ...(c.mentionEveryone === true ? { mentionEveryone: true } : {}),
    agentId: c.agentId,
    roomId: c.roomId,
    roomRoster: c.roomRoster,
    graphThreadId: c.graphThreadId,
    threadId: c.threadId,
    voiceMode: c.voiceMode,
    autoApprove: c.autoApprove === true,
    actorRole: c.actorRole,
    turnId: c.turnId,
    currentFolder: c.currentFolder,
    ...(c.currentFolderRelayId !== undefined
      ? { currentFolderRelayId: c.currentFolderRelayId }
      : {}),
    ...(c.verifiedOrdinaryOrigin !== undefined
      ? { verifiedOrdinaryOrigin: c.verifiedOrdinaryOrigin }
      : {}),
    workspacePath: c.workspacePath,
    // These graph channels are ephemeral. Preserve explicit nulls through the
    // coalescer so the foreground graph can clear stale checkpoint state.
    activeMiniApp: c.activeMiniApp,
    liveMiniAppSession: c.liveMiniAppSession ?? null,
    artifactRefs: c.artifactRefs ?? [],
    focusedResources: c.focusedResources ?? [],
    securityAuditIp: c.securityAuditIp,
    securityAuditUserAgent: c.securityAuditUserAgent,
  };
  if (c.memoryAccessEnvelope !== undefined) {
    base["memoryAccessEnvelope"] = c.memoryAccessEnvelope;
  }
  if (c.replyToMessageId !== undefined && c.replyToMessageId !== null) {
    base["replyToMessageId"] = c.replyToMessageId;
  }
  if (c.humanAlreadyPersisted) {
    base["humanAlreadyPersisted"] = true;
  }
  if (c.passthrough) {
    for (const [k, v] of Object.entries(c.passthrough)) {
      base[k] = v;
    }
  }
  return base;
}
