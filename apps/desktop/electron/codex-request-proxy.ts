import type {
  EnabledServerRequestMethod,
  ServerRequestContext,
  ServerRequestParamsMap,
  ServerRequestResponseMap,
} from "@nautilo/codex-app-server";
import type { RelayCodexRequestMessage, RelayCodexRequestResponseMessage } from "@nautilo/relay";

type CodexBaseApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type CodexHumanRequestMethod = EnabledServerRequestMethod;

/**
 * The one generated-type boundary for Codex-native human requests.
 */
export interface CodexHumanRequestDispatcher {
  <M extends CodexHumanRequestMethod>(input: {
    readonly method: M;
    readonly params: ServerRequestParamsMap[M];
    readonly context: ServerRequestContext;
    readonly projected: ProjectedCodexHumanRequest;
  }): Promise<RelayHumanResponse>;
}

type RelayHumanRequest = RelayCodexRequestMessage["request"];
type RelayHumanResponse = RelayCodexRequestResponseMessage["response"];
export type CodexHumanRelayResponse = RelayHumanResponse;
type ApprovalRequestKind = "command_approval" | "network_approval" | "file_change_approval";

export interface ProjectedCodexHumanRequest {
  readonly threadId: string;
  /** Legacy approval requests omit turn identity; no active-turn inference occurs here. */
  readonly turnId: string | null;
  readonly itemId: string;
  readonly request: RelayHumanRequest;
}


const DEFAULT_CHOICES = [
  "accept", "acceptForSession", "decline", "cancel",
] as const satisfies readonly CodexBaseApprovalDecision[];

/**
 * Deterministic generated-type → semantic-relay projection.
 *
 * It deliberately does not relay raw commands, cwd, grant roots, or requested
 * filesystem paths. Those values require a workspace-aware host-local renderer
 * before they may be shown. The response builder retains the original typed
 * params, so opaque option IDs and permission grants still round-trip exactly.
 */
export function projectCodexHumanRequest<M extends CodexHumanRequestMethod>(
  method: M,
  params: ServerRequestParamsMap[M],
  expiresAt: string,
): ProjectedCodexHumanRequest {
  switch (method) {
    case "applyPatchApproval": {
      const value = params as ServerRequestParamsMap["applyPatchApproval"];
      return fileChange(
        value.conversationId,
        null,
        value.callId,
        detailState(value.reason),
        detailState(value.grantRoot),
        DEFAULT_CHOICES,
        expiresAt,
      );
    }
    case "execCommandApproval": {
      const value = params as ServerRequestParamsMap["execCommandApproval"];
      return command(
        value.conversationId,
        null,
        value.callId,
        detailState(value.reason),
        detailState(value.command.length > 0 ? "present" : null),
        [],
        DEFAULT_CHOICES,
        expiresAt,
      );
    }
    case "item/commandExecution/requestApproval": {
      const value = params as ServerRequestParamsMap["item/commandExecution/requestApproval"];
      const choices = offeredBaseChoices(value.availableDecisions);
      if (value.networkApprovalContext) {
        return network(
          value.threadId,
          value.turnId,
          value.itemId,
          detailState(value.reason),
          value.networkApprovalContext,
          choices,
          expiresAt,
        );
      }
      return command(
        value.threadId,
        value.turnId,
        value.itemId,
        detailState(value.reason),
        detailState(value.command),
        actionKinds(value.commandActions),
        choices,
        expiresAt,
      );
    }
    case "item/fileChange/requestApproval": {
      const value = params as ServerRequestParamsMap["item/fileChange/requestApproval"];
      return fileChange(
        value.threadId,
        value.turnId,
        value.itemId,
        detailState(value.reason),
        detailState(value.grantRoot),
        DEFAULT_CHOICES,
        expiresAt,
      );
    }
    case "item/permissions/requestApproval": {
      const value = params as ServerRequestParamsMap["item/permissions/requestApproval"];
      return {
        threadId: value.threadId,
        turnId: value.turnId,
        itemId: value.itemId,
        request: {
          kind: "permissions_approval",
          reason: detailState(value.reason),
          permissions: permissionPresentation(value.permissions),
          expiresAt,
        },
      };
    }
    case "item/tool/requestUserInput": {
      const value = params as ServerRequestParamsMap["item/tool/requestUserInput"];
      return {
        threadId: value.threadId,
        turnId: value.turnId,
        itemId: value.itemId,
        request: {
          kind: "user_input",
          questions: value.questions.map(projectQuestion),
          // The deadline is optional on the wire; preserve it when the runtime supplies one.
          autoResolutionMs: optionalAutoResolutionMs(value),
          expiresAt,
        },
      };
    }
    default:
      return assertNever(method);
  }
}

/** Deterministic semantic relay response → exact generated response shape. */
export function resolveCodexHumanRequest<M extends CodexHumanRequestMethod>(
  method: M,
  params: ServerRequestParamsMap[M],
  response: RelayHumanResponse,
): ServerRequestResponseMap[M] {
  if (method === "item/tool/requestUserInput") {
    if (response.kind !== "user_input") throw new Error("Codex response kind mismatch");
    const questions = (params as ServerRequestParamsMap["item/tool/requestUserInput"]).questions;
    return { answers: resolveInputAnswers(questions, response.answers) } as ServerRequestResponseMap[M];
  }

  if (method === "item/permissions/requestApproval") {
    if (response.kind !== "permissions_approval") throw new Error("Codex response kind mismatch");
    const requested = (params as ServerRequestParamsMap["item/permissions/requestApproval"]).permissions;
    return {
      permissions: {
        ...(response.grants.network && requested.network ? { network: requested.network } : {}),
        ...(response.grants.fileSystem && requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
      },
      scope: response.scope,
    } as ServerRequestResponseMap[M];
  }

  const expectedKind = approvalKindFor(method, params);
  if (response.kind !== expectedKind) throw new Error("Codex response kind mismatch");
  const offered = method === "item/commandExecution/requestApproval"
    ? offeredBaseChoices((params as ServerRequestParamsMap["item/commandExecution/requestApproval"]).availableDecisions)
    : DEFAULT_CHOICES;
  if (!offered.includes(response.decision)) {
    throw new Error("Codex decision was not offered by the app-server");
  }

  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    const decision = {
      accept: "approved",
      acceptForSession: "approved_for_session",
      decline: "denied",
      cancel: "abort",
    } as const;
    return { decision: decision[response.decision] } as ServerRequestResponseMap[M];
  }
  return { decision: response.decision } as ServerRequestResponseMap[M];
}

/**
 * Bridges the supported Codex-native human-request union to the local broker.
 */
export function dispatchCodexHumanServerRequest<M extends EnabledServerRequestMethod>(
  method: M,
  params: ServerRequestParamsMap[M],
  context: ServerRequestContext,
  dispatch: CodexHumanRequestDispatcher,
): Promise<ServerRequestResponseMap[M]> {
  switch (method) {
    case "applyPatchApproval":
      return dispatchHumanRequest("applyPatchApproval", params as ServerRequestParamsMap["applyPatchApproval"], context, dispatch) as Promise<ServerRequestResponseMap[M]>;
    case "execCommandApproval":
      return dispatchHumanRequest("execCommandApproval", params as ServerRequestParamsMap["execCommandApproval"], context, dispatch) as Promise<ServerRequestResponseMap[M]>;
    case "item/commandExecution/requestApproval":
      return dispatchHumanRequest("item/commandExecution/requestApproval", params as ServerRequestParamsMap["item/commandExecution/requestApproval"], context, dispatch) as Promise<ServerRequestResponseMap[M]>;
    case "item/fileChange/requestApproval":
      return dispatchHumanRequest("item/fileChange/requestApproval", params as ServerRequestParamsMap["item/fileChange/requestApproval"], context, dispatch) as Promise<ServerRequestResponseMap[M]>;
    case "item/permissions/requestApproval":
      return dispatchHumanRequest("item/permissions/requestApproval", params as ServerRequestParamsMap["item/permissions/requestApproval"], context, dispatch) as Promise<ServerRequestResponseMap[M]>;
    case "item/tool/requestUserInput":
      return dispatchHumanRequest("item/tool/requestUserInput", params as ServerRequestParamsMap["item/tool/requestUserInput"], context, dispatch) as Promise<ServerRequestResponseMap[M]>;
    default:
      return Promise.reject(new Error("Unsupported Codex server request"));
  }
}

async function dispatchHumanRequest<M extends CodexHumanRequestMethod>(
  method: M,
  params: ServerRequestParamsMap[M],
  context: ServerRequestContext,
  dispatch: CodexHumanRequestDispatcher,
): Promise<ServerRequestResponseMap[M]> {
  const projected = projectCodexHumanRequest(method, params, context.expiresAt);
  const response = await dispatch({ method, params, context, projected });
  return resolveCodexHumanRequest(method, params, response);
}

function command(
  threadId: string,
  turnId: string | null,
  itemId: string,
  reason: "not_provided" | "host_local_only",
  detail: "not_provided" | "host_local_only",
  actionKinds: readonly ("read" | "list_files" | "search" | "unknown")[],
  choices: readonly CodexBaseApprovalDecision[],
  expiresAt: string,
): ProjectedCodexHumanRequest {
  return {
    threadId,
    turnId,
    itemId,
    request: { kind: "command_approval", reason, command: { detail, actionKinds }, choices, expiresAt },
  };
}

function network(
  threadId: string,
  turnId: string,
  itemId: string,
  reason: "not_provided" | "host_local_only",
  context: NonNullable<ServerRequestParamsMap["item/commandExecution/requestApproval"]["networkApprovalContext"]>,
  choices: readonly CodexBaseApprovalDecision[],
  expiresAt: string,
): ProjectedCodexHumanRequest {
  return {
    threadId,
    turnId,
    itemId,
    request: {
      kind: "network_approval",
      reason,
      network: { host: bounded(context.host, 253), protocol: context.protocol },
      choices,
      expiresAt,
    },
  };
}

function fileChange(
  threadId: string,
  turnId: string | null,
  itemId: string,
  reason: "not_provided" | "host_local_only",
  grantRoot: "not_provided" | "host_local_only",
  choices: readonly CodexBaseApprovalDecision[],
  expiresAt: string,
): ProjectedCodexHumanRequest {
  return {
    threadId,
    turnId,
    itemId,
    request: { kind: "file_change_approval", reason, grantRoot, choices, expiresAt },
  };
}

function offeredBaseChoices(value: readonly unknown[] | null | undefined): readonly CodexBaseApprovalDecision[] {
  if (value === null || value === undefined) return DEFAULT_CHOICES;
  const offered = value.filter(isBaseDecision);
  const unique = [...new Set(offered)];
  if (unique.length === 0) {
    throw new Error("Codex offered only unsupported policy-amendment decisions");
  }
  return unique;
}

function isBaseDecision(value: unknown): value is CodexBaseApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function detailState(value: string | readonly string[] | null | undefined): "not_provided" | "host_local_only" {
  if (Array.isArray(value)) return value.length > 0 ? "host_local_only" : "not_provided";
  return value === null || value === undefined || value.length === 0 ? "not_provided" : "host_local_only";
}

function actionKinds(value: ServerRequestParamsMap["item/commandExecution/requestApproval"]["commandActions"]): readonly ("read" | "list_files" | "search" | "unknown")[] {
  const mapped = (value ?? []).map((action) => {
    if (action.type === "read") return "read";
    if (action.type === "listFiles") return "list_files";
    if (action.type === "search") return "search";
    return "unknown";
  });
  return [...new Set(mapped)].slice(0, 16);
}

function permissionPresentation(value: ServerRequestParamsMap["item/permissions/requestApproval"]["permissions"]) {
  const fileSystem = value.fileSystem;
  return {
    network: value.network ? { enabled: value.network.enabled } : null,
    fileSystem: fileSystem ? {
      readPathCount: fileSystem.read?.length ?? 0,
      writePathCount: fileSystem.write?.length ?? 0,
      entryCount: fileSystem.entries?.length ?? 0,
      pathDetail: "host_local_only" as const,
    } : null,
  };
}

function projectQuestion(question: ServerRequestParamsMap["item/tool/requestUserInput"]["questions"][number]) {
  return {
    id: question.id,
    header: question.header,
    question: question.question,
    isOther: question.isOther,
    isSecret: question.isSecret,
    options: question.options?.map((option, index) => ({
      id: opaqueOptionId(question.id, index),
      label: option.label,
      description: option.description,
    })) ?? null,
  };
}

function opaqueOptionId(_questionId: string, index: number): string {
  // This names a local selection slot, never the upstream option label.
  return `option:${index}`;
}

function resolveInputAnswers(
  questions: ServerRequestParamsMap["item/tool/requestUserInput"]["questions"],
  answers: Readonly<Record<string, { readonly answers: readonly string[] }>>,
): Readonly<Record<string, { readonly answers: readonly string[] }>> {
  const byId = new Map(questions.map((question) => [question.id, question] as const));
  const resolved: Record<string, { readonly answers: readonly string[] }> = {};
  for (const [questionId, answer] of Object.entries(answers)) {
    const question = byId.get(questionId);
    if (!question) throw new Error("Codex answer referenced an unknown question");
    const labels = new Map((question.options ?? []).map((option, index) => [
      opaqueOptionId(question.id, index), option.label,
    ] as const));
    resolved[questionId] = {
      answers: answer.answers.map((value) => {
        const label = labels.get(value);
        if (label !== undefined) return label;
        if (question.options === null || question.isOther) return value;
        throw new Error("Codex answer was not one of the offered options");
      }),
    };
  }
  return resolved;
}

function optionalAutoResolutionMs(params: ServerRequestParamsMap["item/tool/requestUserInput"]): number | null {
  const value = params.autoResolutionMs;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bounded(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = "...";
  const limit = maxBytes - encoder.encode(suffix).byteLength;
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes + size > limit) break;
    bytes += size;
    end += codePoint.length;
  }
  return `${value.slice(0, end)}${suffix}`;
}

function approvalKindFor<M extends Exclude<CodexHumanRequestMethod, "item/tool/requestUserInput" | "item/permissions/requestApproval">>(
  method: M,
  params: ServerRequestParamsMap[M],
): ApprovalRequestKind {
  if (method === "applyPatchApproval" || method === "item/fileChange/requestApproval") return "file_change_approval";
  if (method === "execCommandApproval") return "command_approval";
  return (params as ServerRequestParamsMap["item/commandExecution/requestApproval"]).networkApprovalContext
    ? "network_approval"
    : "command_approval";
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Codex human request: ${String(value)}`);
}
