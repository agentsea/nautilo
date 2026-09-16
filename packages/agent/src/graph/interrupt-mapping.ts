import {
  isMediaGenerationApproval,
  type ServerEvent,
  type StructuredSshApproval,
} from "@nautilo/types";
import {
  RELAY_SSH_HARD_TIMEOUT_SECONDS,
  RELAY_SSH_SOFT_TIMEOUT_SECONDS,
  RELAY_SSH_TIMEOUT_REASON_MAX_BYTES,
  RELAY_SSH_TIMEOUT_REASON_MIN_BYTES,
} from "@nautilo/relay";

/**
 * Translate a LangGraph interrupt payload (from `graph.getState()` →
 * `task.interrupts[i].value`) into the public-facing ServerEvent that
 * is fanned out over the WebSocket.
 *
 * This is the single place that maps internal interrupt discriminators
 * (underscored, e.g. `approval_ask`) to public event types (dotted,
 * e.g. `approval.ask`). Without a test surface, every new interrupt
 * handler requires an end-to-end graph run to validate. The helper
 * makes the mapping table a pure function.
 *
 * Ownership: this lives in `@nautilo/agent` because the agent package
 * owns the internal interrupt shapes (post-model emits them). Every
 * caller that needs to translate an interrupt for WS fanout — the
 * runtime's first-turn executor, and the agent's resume-approval /
 * resume-approval-ask / resume-identity paths — imports from here.
 *
 * Returns `null` for unknown / missing values so the caller can skip.
 *
 * Supported interrupt values:
 *   { type: "identity_challenge", challengeId, expiresAt }
 *   { type: "prove_it_challenge", tools }
 *   { type: "approval_ask",       tools, reason, reasonCode, allowedVerbs }
 */
export function interruptValueToServerEvent(
  value: Record<string, unknown> | undefined,
  threadId: string,
  laneKey: string,
): ServerEvent | null {
  if (!value || typeof value !== "object") return null;

  const type = value["type"];

  if (type === "identity_challenge") {
    // M054: optional `mode` distinguishes "verify a known user" (the
    // M036 default; legacy verify-and-resume path removed post-M072)
    // from "enroll a PIN for a Logto-authed user who doesn't have one
    // yet". Absent means "verify" so older callers keep working.
    const rawMode = value["mode"];
    const mode =
      rawMode === "enrollPin" || rawMode === "verify" ? rawMode : undefined;
    const rawUserId = value["userId"];
    const userId =
      typeof rawUserId === "string" && rawUserId.length > 0 ? rawUserId : undefined;
    return {
      type: "identity.challenge",
      laneKey,
      threadId,
      challengeId: (value["challengeId"] as string) ?? "",
      expiresAt: (value["expiresAt"] as string) ?? "",
      ...(mode ? { mode } : {}),
      ...(userId ? { userId } : {}),
    };
  }

  if (type === "prove_it_challenge") {
    const tools =
      (value["tools"] as Array<{ name: string; args: Record<string, unknown>; id?: string }>) ?? [];
    const rawUid = value["userId"];
    const userId =
      typeof rawUid === "string" && rawUid.length > 0 ? rawUid : undefined;
    return {
      type: "prove_it.challenge",
      threadId,
      laneKey,
      tools,
      ...(userId ? { userId } : {}),
    };
  }

  if (type === "approval_ask") {
    // D061 Phase 2 — graduated ask-verb approval.
    // post-model.ts emits `approval_ask` (underscore — internal payload
    // shape); we translate to `approval.ask` (dot — public WS event)
    // and attach execution context same as the prove_it path above.
    const tools =
      (value["tools"] as Array<{ name: string; args: Record<string, unknown>; id?: string }>) ?? [];
    const reason = (value["reason"] as string) ?? "";
    const approvalId =
      typeof value["approvalId"] === "string" && value["approvalId"].length > 0
        ? value["approvalId"]
        : `${threadId}:${laneKey}`;
    const reasonCode =
      (value["reasonCode"] as
        | "command-scanner-medium"
        | "command-scanner-high"
        | "external-binary"
        | "destructive-tool"
        | "network-egress-denied"
        | "tier-bump") ?? "destructive-tool";
    const allowedVerbs =
      (value["allowedVerbs"] as Array<"once" | "room" | "always" | "deny">) ??
      ["once", "room", "always", "deny"];
    const scopeInfo = Array.isArray(value["scopeInfo"])
      ? (value["scopeInfo"] as Array<{
          onceDisplay: string;
          generalizedDisplay: string;
          sameAsOnce: boolean;
        }>)
      : undefined;
    const rawUid = value["userId"];
    const userId =
      typeof rawUid === "string" && rawUid.length > 0 ? rawUid : undefined;
    const localMcpInstall = isLocalMcpInstallApproval(value["localMcpInstall"])
      ? value["localMcpInstall"]
      : undefined;
    const mediaGeneration = isMediaGenerationApproval(value["mediaGeneration"])
      ? value["mediaGeneration"]
      : undefined;
    const structuredSsh = isStructuredSshApproval(value["structuredSsh"])
      ? value["structuredSsh"]
      : undefined;
    // This payload authorizes a one-use preparation.  A malformed or widened
    // instance must not silently degrade into a normal approval ask.
    if (value["structuredSsh"] !== undefined && structuredSsh === undefined) return null;
    if (value["mediaGeneration"] !== undefined && mediaGeneration === undefined) return null;
    return {
      type: "approval.ask",
      approvalId,
      threadId,
      laneKey,
      tools,
      reason,
      reasonCode,
      ...(isNetworkContext(value["network"]) ? { network: value["network"] } : {}),
      // An SSH preparation is a one-use, exact-review capability.  Never
      // carry a broader verb list across this public interrupt boundary.
      allowedVerbs: structuredSsh || mediaGeneration ? ["once", "deny"] : allowedVerbs,
      ...(scopeInfo ? { scopeInfo } : {}),
      ...(localMcpInstall ? { localMcpInstall, requiresExplicitReview: true } : {}),
      ...(mediaGeneration ? { mediaGeneration, requiresExplicitReview: true } : {}),
      ...(structuredSsh ? { structuredSsh, requiresExplicitReview: true } : {}),
      ...(userId ? { userId } : {}),
    };
  }

  if (type === "host_choice") {
    const choiceId = typeof value["choiceId"] === "string" ? value["choiceId"] : "";
    const toolCallId = typeof value["toolCallId"] === "string" ? value["toolCallId"] : "";
    const toolName = typeof value["toolName"] === "string" ? value["toolName"] : "";
    const options = Array.isArray(value["options"])
      ? (value["options"] as Array<{ selector: string; label: string }>).filter(
          (option) =>
            option &&
            typeof option.selector === "string" &&
            typeof option.label === "string",
        )
      : [];
    const rawUid = value["userId"];
    const userId = typeof rawUid === "string" && rawUid.length > 0 ? rawUid : undefined;
    if (!choiceId || !toolCallId || !toolName || options.length < 2) return null;
    return {
      type: "host.choice",
      choiceId,
      threadId,
      laneKey,
      toolCallId,
      toolName,
      options,
      ...(userId ? { userId } : {}),
    };
  }

  if (type === "connected_web_action_attention") {
    const toolCallId = typeof value["toolCallId"] === "string" ? value["toolCallId"] : "";
    const intervention = value["intervention"];
    const sealed = connectedWebAuthenticationIntervention(intervention);
    if (!toolCallId || !sealed) return null;
    const userId = typeof value["userId"] === "string" && value["userId"].length > 0 ? value["userId"] : undefined;
    if (!userId) return null;
    return { type: "connected_web.action_attention", threadId, laneKey, toolCallId, userId, intervention: sealed };
  }

  if (type === "await_human_reply") {
    // M151 (Task Phase 7a) — a run parked awaiting a human reply. The peer sees
    // the agent's question via the normal room-scoped `message.new`; this event
    // is the owner-private lifecycle signal (D14, routed by `ownerId`).
    return {
      type: "task.awaiting_reply",
      threadId,
      laneKey,
      targetRoomId: (value["targetRoomId"] as string) ?? "",
      awaitingFromUserIds: Array.isArray(value["awaitingFromUserIds"])
        ? (value["awaitingFromUserIds"] as string[])
        : [],
      ...(typeof value["taskId"] === "string" && value["taskId"]
        ? { taskId: value["taskId"] }
        : {}),
      ...(typeof value["taskRunId"] === "string" && value["taskRunId"]
        ? { taskRunId: value["taskRunId"] }
        : {}),
      ownerId: (value["ownerId"] as string) ?? "",
    };
  }

  return null;
}

function connectedWebAuthenticationIntervention(value: unknown): Extract<ServerEvent, { type: "connected_web.action_attention" }>['intervention'] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const boundedText = (candidate: unknown, max: number): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0 && candidate.length <= max;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "authentication_required") return null;
  if (record["mode"] === "connect") {
    const selector = record["target"] && typeof record["target"] === "object" && !Array.isArray(record["target"]) ? (record["target"] as Record<string, unknown>)["selector"] : null;
    return record["reason"] === "not_connected" && boundedText(selector, 2_048) ? { kind: "authentication_required", mode: "connect", reason: "not_connected", target: { selector } } : null;
  }
  const reason = record["reason"];
  if (record["mode"] !== "reconnect"
    || (reason !== "reconnect" && reason !== "sign_in" && reason !== "mfa" && reason !== "captcha")) return null;
  if (!record["account"] || typeof record["account"] !== "object" || Array.isArray(record["account"])) return null;
  const account = record["account"] as Record<string, unknown>;
  if (!boundedText(account["id"], 128) || !boundedText(account["label"], 256)
    || !boundedText(account["service"], 128) || !boundedText(account["origin"], 2_048)) return null;
  return { kind: "authentication_required", mode: "reconnect", reason, account: { id: account["id"], label: account["label"], service: account["service"], origin: account["origin"] } };
}

function isStructuredSshApproval(value: unknown): value is StructuredSshApproval {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const keys = new Set([
    "version", "toolCallId", "approvedRequestDigest", "preparationId", "operation", "host", "port",
    "remoteUser", "hostKeyFingerprint", "hostTrust", "previousHostKeyFingerprint", "program", "argv", "localPath", "remotePath",
    "timeoutSeconds", "timeoutReason",
  ]);
  if (Object.keys(raw).some((key) => !keys.has(key))) return false;
  if (
    raw["version"] !== "structured-ssh-v1" || typeof raw["toolCallId"] !== "string" ||
    typeof raw["approvedRequestDigest"] !== "string" || !/^[a-f0-9]{64}$/.test(raw["approvedRequestDigest"]) ||
    typeof raw["preparationId"] !== "string" || typeof raw["host"] !== "string" ||
    !Number.isSafeInteger(raw["port"]) || (raw["port"] as number) < 1 || (raw["port"] as number) > 65_535 ||
    typeof raw["remoteUser"] !== "string" || typeof raw["hostKeyFingerprint"] !== "string" ||
    (raw["operation"] !== "auth" && raw["operation"] !== "exec" && raw["operation"] !== "copy-upload" && raw["operation"] !== "copy-download") ||
    (raw["hostTrust"] !== "trusted" && raw["hostTrust"] !== "unknown" && raw["hostTrust"] !== "changed") ||
    (raw["hostTrust"] === "changed"
      ? typeof raw["previousHostKeyFingerprint"] !== "string" || raw["previousHostKeyFingerprint"] === raw["hostKeyFingerprint"]
      : raw["previousHostKeyFingerprint"] !== undefined)
  ) return false;
  const timeoutSeconds = raw["timeoutSeconds"];
  const timeoutReason = raw["timeoutReason"];
  if (
    timeoutSeconds !== undefined &&
    (!Number.isSafeInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 ||
      (timeoutSeconds as number) > RELAY_SSH_HARD_TIMEOUT_SECONDS)
  ) return false;
  if (timeoutReason !== undefined) {
    if (
      typeof timeoutReason !== "string" || timeoutSeconds === undefined ||
      (timeoutSeconds as number) <= RELAY_SSH_SOFT_TIMEOUT_SECONDS
    ) return false;
    const reasonBytes = Buffer.byteLength(timeoutReason, "utf8");
    if (
      reasonBytes < RELAY_SSH_TIMEOUT_REASON_MIN_BYTES ||
      reasonBytes > RELAY_SSH_TIMEOUT_REASON_MAX_BYTES ||
      // eslint-disable-next-line no-control-regex -- review text is a single-line protocol field; NUL is never valid.
      /[\u0000\r\n]/u.test(timeoutReason)
    ) return false;
  } else if (
    timeoutSeconds !== undefined &&
    (timeoutSeconds as number) > RELAY_SSH_SOFT_TIMEOUT_SECONDS
  ) return false;
  if (raw["operation"] === "auth") return raw["program"] === undefined && raw["argv"] === undefined && raw["localPath"] === undefined && raw["remotePath"] === undefined;
  if (raw["operation"] === "exec") return typeof raw["program"] === "string" && Array.isArray(raw["argv"]) && raw["argv"].every((arg) => typeof arg === "string") && raw["localPath"] === undefined && raw["remotePath"] === undefined;
  return raw["program"] === undefined && raw["argv"] === undefined && typeof raw["localPath"] === "string" && typeof raw["remotePath"] === "string";
}

function isLocalMcpInstallApproval(value: unknown): value is NonNullable<
  Extract<ServerEvent, { type: "approval.ask" }>["localMcpInstall"]
> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const preview = record["preview"];
  return record["version"] === "local-mcp-install-v1" &&
    typeof record["digest"] === "string" &&
    record["digest"].length > 0 &&
    preview !== null && typeof preview === "object" && !Array.isArray(preview);
}

function isNetworkContext(value: unknown): value is {
  host: string;
  port: number;
  reason: string;
  suggestedRule: {
    type: "domain" | "wildcard" | "cidr";
    host?: string;
    suffix?: string;
    cidr?: string;
    ports?: readonly number[];
  };
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["host"] === "string" &&
    typeof record["port"] === "number" &&
    typeof record["reason"] === "string" &&
    isNetworkSuggestedRule(record["suggestedRule"])
  );
}

function isNetworkSuggestedRule(
  value: unknown,
): value is {
  type: "domain" | "wildcard" | "cidr";
  host?: string;
  suffix?: string;
  cidr?: string;
  ports?: readonly number[];
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const type = record["type"];
  if (type !== "domain" && type !== "wildcard" && type !== "cidr") return false;
  if (type === "domain" && typeof record["host"] !== "string") return false;
  if (type === "wildcard" && typeof record["suffix"] !== "string") return false;
  if (type === "cidr" && typeof record["cidr"] !== "string") return false;
  const ports = record["ports"];
  return ports === undefined ||
    (Array.isArray(ports) && ports.every((p) => typeof p === "number"));
}

/**
 * Scan a graph's post-resume state for interrupts and translate each
 * to a ServerEvent. D084 — the resume paths (resume-approval-ask,
 * resume-approval) called this, so a chained interrupt raised on the
 * NEXT step of a multi-step task is surfaced rather than silently
 * held in the checkpointer.
 *
 * Matches the first-turn executor's scan shape (langgraph-executor.ts
 * ~lines 154-175) so the fanout contract is identical whether you
 * entered via first-message or resume.
 */
export function collectPendingInterruptEvents(
  graphState: {
    tasks?: Array<Record<string, unknown>>;
    values?: unknown;
  } | undefined,
  threadId: string,
  laneKey: string,
): ServerEvent[] {
  const out: ServerEvent[] = [];
  const projectionExpiries = projectionExpiryByToolCallId(graphState?.values);
  const tasks = graphState?.tasks;
  if (!tasks) return out;
  for (const task of tasks) {
    const interrupts = task["interrupts"] as Array<Record<string, unknown>> | undefined;
    if (!interrupts) continue;
    for (const intr of interrupts) {
      const value = intr["value"] as Record<string, unknown> | undefined;
      const mapped = interruptValueToServerEvent(value, threadId, laneKey);
      const event = mapped === null
        ? null
        : enrichProjectionExpiry(mapped, projectionExpiries);
      if (event?.type === "prove_it.challenge") {
        const interruptId = intr["id"];
        out.push({
          ...event,
          ...(typeof interruptId === "string" && interruptId.length > 0
            ? { challengeId: interruptId }
            : {}),
        });
      } else if (event) {
        out.push(event);
      }
    }
  }
  return out;
}

function projectionExpiryByToolCallId(values: unknown): ReadonlyMap<string, number> {
  if (!values || typeof values !== "object" || Array.isArray(values)) return new Map();
  const snapshots = (values as Record<string, unknown>)["projectionSnapshots"];
  if (!Array.isArray(snapshots)) return new Map();

  const candidates = new Map<string, number[]>();
  for (const candidate of snapshots) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const snapshot = candidate as Record<string, unknown>;
    const toolCallId = snapshot["toolCallId"];
    const reference = snapshot["reference"];
    const expiresAt = snapshot["kind"] === "protected" && reference &&
        typeof reference === "object" && !Array.isArray(reference)
      ? (reference as Record<string, unknown>)["expiresAt"]
      : snapshot["expiresAt"];
    if (typeof toolCallId !== "string" || toolCallId.length === 0 ||
        typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) continue;
    candidates.set(toolCallId, [...(candidates.get(toolCallId) ?? []), expiresAt]);
  }

  return new Map(
    [...candidates].flatMap(([toolCallId, expiries]) =>
      expiries.length === 1 ? [[toolCallId, expiries[0]!] as const] : []
    ),
  );
}

function enrichProjectionExpiry(
  event: ServerEvent,
  expiries: ReadonlyMap<string, number>,
): ServerEvent {
  if (event.type !== "prove_it.challenge" && event.type !== "approval.ask") return event;
  let changed = false;
  const tools = event.tools.map((tool) => {
    const projection = tool.shareMemoryPreview?.projection;
    const expiresAt = tool.id === undefined ? undefined : expiries.get(tool.id);
    if (projection === undefined || projection.expiresAt !== undefined || expiresAt === undefined) {
      return tool;
    }
    changed = true;
    return {
      ...tool,
      shareMemoryPreview: {
        ...tool.shareMemoryPreview!,
        projection: { ...projection, expiresAt },
      },
    };
  });
  return changed ? { ...event, tools } : event;
}

export interface PendingGraphInterrupt {
  readonly id?: string;
  readonly value: Record<string, unknown>;
}

function pendingGraphInterrupts(
  graphState: { tasks?: Array<Record<string, unknown>> } | undefined,
): PendingGraphInterrupt[] {
  const pending: PendingGraphInterrupt[] = [];
  for (const task of graphState?.tasks ?? []) {
    const interrupts = task["interrupts"];
    if (!Array.isArray(interrupts)) continue;
    for (const candidate of interrupts) {
      if (!candidate || typeof candidate !== "object") continue;
      const interrupt = candidate as Record<string, unknown>;
      const value = interrupt["value"];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const id = interrupt["id"];
      pending.push({
        ...(typeof id === "string" && id.length > 0 ? { id } : {}),
        value: value as Record<string, unknown>,
      });
    }
  }
  return pending;
}

/** Resolve the exact pending prove-it interrupt named by its public challenge id. */
export function requirePendingProveItInterrupt(
  graphState: { tasks?: Array<Record<string, unknown>> } | undefined,
  expectedChallengeId: string,
): PendingGraphInterrupt {
  const sameId = pendingGraphInterrupts(graphState)
    .filter((interrupt) => interrupt.id === expectedChallengeId);
  if (sameId.length !== 1 || sameId[0]!.value["type"] !== "prove_it_challenge") {
    throw Object.assign(new Error("The approval challenge is no longer the exact pending prove-it request."), {
      code: "approval_request_stale",
    });
  }
  return sameId[0]!;
}

/** Resolve an approval.ask by its durable public approval id. */
export function requirePendingApprovalAskInterrupt(
  graphState: { tasks?: Array<Record<string, unknown>> } | undefined,
  expectedApprovalId: string,
): PendingGraphInterrupt {
  const matches = pendingGraphInterrupts(graphState).filter((interrupt) =>
    interrupt.value["type"] === "approval_ask" &&
    interrupt.value["approvalId"] === expectedApprovalId
  );
  if (matches.length !== 1) {
    throw Object.assign(new Error("The approval request is no longer the exact pending approval."), {
      code: "approval_request_stale",
    });
  }
  return matches[0]!;
}
