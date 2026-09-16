import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isRelayCodexCommandResponseForCommand, parseRelayCodexServerMessage } from "@nautilo/relay";
import type {
  BindingIdentityScope, BindingOpenScope, BindingScope, CodexPosture,
  HostScope, ProfileLaunchScope, ProfileScope, RelayCodexCommandMessage,
  RelayCodexCommandResponseMessage, RelayCodexEventMessage, TurnScope,
} from "@nautilo/relay";

const opaque = z.string().min(1).max(512);
const text = z.string().min(1).max(64 * 1024);
const generation = z.number().int().nonnegative();
const postureName = z.enum(["default", "prompted_workspace", "full_access_headless"]);
const empty = <T extends string>(operation: T) => z.object({ operation: z.literal(operation) }).strict();
const canonicalIso = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value);

export const CodexSemanticCommandSchema = z.discriminatedUnion("operation", [
  empty("runtime_inspect"), z.object({ operation: z.literal("runtime_install"), artifactRef: opaque }).strict(),
  z.object({ operation: z.literal("runtime_cancel_install"), installRef: opaque }).strict(),
  z.object({ operation: z.literal("runtime_activate"), runtimeGeneration: generation }).strict(),
  empty("runtime_rollback"), z.object({ operation: z.literal("runtime_remove"), runtimeGeneration: generation }).strict(),
  z.object({ operation: z.literal("profile_create"), profileHandle: opaque, profileGeneration: generation }).strict(),
  z.object({ operation: z.literal("profile_remove"), profileHandle: opaque, profileGeneration: generation }).strict(),
  empty("account_login_start"), z.object({ operation: z.literal("account_login_cancel"), loginRef: opaque }).strict(),
  empty("account_read"), empty("account_logout"), empty("account_rate_limits_read"), empty("account_usage_read"), empty("model_list"),
  z.object({ operation: z.literal("ensure_profile_child"), posture: postureName.default("default") }).strict(),
  empty("rebind_binding"), empty("resume_binding"), empty("release_binding"),
  z.object({ operation: z.literal("start_turn"), userText: text, collaborationMode: z.enum(["work", "plan"]).default("work") }).strict(),
  z.object({ operation: z.literal("steer_turn"), userText: text, actorRef: opaque }).strict(),
  z.object({ operation: z.literal("interrupt_turn"), reason: z.enum(["user_stop", "deadline", "drain"]) }).strict(),
  z.object({ operation: z.literal("drain_profile"), deadlineAt: canonicalIso }).strict(),
  z.object({ operation: z.literal("terminate_child"), reason: z.enum(["interrupt_escalation", "host_shutdown"]) }).strict(),
]);
export type CodexSemanticCommand = z.infer<typeof CodexSemanticCommandSchema>;
export interface CodexRelaySemanticScopes {
  readonly resolveHostScope: () => HostScope;
  readonly resolveProfileLaunchScope?: () => ProfileLaunchScope;
  readonly resolveProfileScope?: () => ProfileScope;
  readonly resolveBindingOpenScope?: () => BindingOpenScope;
  readonly resolveRebindScopes?: () => Readonly<{ current: BindingIdentityScope; successor: BindingScope }>;
  readonly resolveBindingScope?: () => BindingScope;
  readonly resolveTurnScope?: () => TurnScope;
}
export interface CodexRelaySemanticAdapterOptions {
  readonly sendCommand: (relayId: string, command: RelayCodexCommandMessage) => Promise<RelayCodexCommandResponseMessage>;
  readonly scopes: CodexRelaySemanticScopes;
  readonly mintId?: () => string;
}
export type CodexSemanticResult = {
  readonly commandId: string; readonly status: "ok" | "rejected";
  readonly result: RelayCodexCommandResponseMessage["result"];
  readonly childGeneration?: number; readonly threadId?: string;
  readonly turn?: Readonly<{ turnId: string }>;
};
export type CodexSemanticEvent = { readonly profileHandle: string; readonly bindingId?: string; readonly turnId?: string; readonly itemId?: string; readonly event: RelayCodexEventMessage["event"] };
function posture(value: "default" | "prompted_workspace" | "full_access_headless"): CodexPosture {
  if (value === "prompted_workspace") return { kind: "prompted_workspace", anchorMode: "workspace-write", approvalPolicy: "on-request" };
  if (value === "full_access_headless") return { kind: "full_access_headless", anchorMode: "danger-full-access", approvalPolicy: "never" };
  return { kind: "codex_default", anchorMode: "default" };
}
type InternalCommand = CodexSemanticCommand | Readonly<{ operation: "open_binding"; model?: string; posture: "default" | "prompted_workspace" | "full_access_headless"; workingDirectory?: string }>;

/** Typed relay envelope/correlation builder. It has no Nautilo callback path. */
export class CodexRelaySemanticAdapter {
  private readonly mintId: () => string;
  constructor(private readonly options: CodexRelaySemanticAdapterOptions) { this.mintId = options.mintId ?? randomUUID; }
  async execute(relayId: string, raw: unknown): Promise<CodexSemanticResult> { return this.executeParsed(relayId, CodexSemanticCommandSchema.parse(raw)); }
  async openBinding(relayId: string, input: Readonly<{ model?: string; posture?: "default" | "prompted_workspace" | "full_access_headless"; workingDirectory?: string }>): Promise<CodexSemanticResult> {
    return this.executeParsed(relayId, {
      operation: "open_binding",
      ...(input.model === undefined ? {} : { model: opaque.parse(input.model) }),
      posture: postureName.parse(input.posture ?? "default"),
      ...(input.workingDirectory === undefined ? {} : { workingDirectory: z.string().min(1).max(4096).parse(input.workingDirectory) }),
    });
  }
  toSemanticEvent(message: RelayCodexEventMessage): CodexSemanticEvent {
    return { profileHandle: message.scope.profileHandle, ...("bindingId" in message.scope ? { bindingId: message.scope.bindingId } : {}), ...("turnId" in message.scope ? { turnId: message.scope.turnId } : {}), ...("itemId" in message.scope ? { itemId: message.scope.itemId } : {}), event: message.event };
  }
  private async executeParsed(relayId: string, input: InternalCommand): Promise<CodexSemanticResult> {
    const commandId = this.mintId(); const envelope = this.buildEnvelope(commandId, input); const parsed = parseRelayCodexServerMessage(envelope);
    if (!parsed.ok || parsed.value.type !== "relay:codex-command") throw new Error("CODEX_FRAME_INVALID");
    const response = await this.options.sendCommand(relayId, parsed.value);
    if (!isRelayCodexCommandResponseForCommand(parsed.value, response)) throw new Error("CODEX_FRAME_INVALID");
    return { commandId, status: response.result.kind === "rejected" ? "rejected" : "ok", result: response.result,
      ...(input.operation === "ensure_profile_child" && response.result.kind === "child_ready" && "childGeneration" in response.scope ? { childGeneration: response.scope.childGeneration } : {}),
      ...(input.operation === "open_binding" && response.result.kind === "binding_ready" && "threadId" in response.scope ? { threadId: response.scope.threadId } : {}),
      ...(input.operation === "start_turn" && response.result.kind === "turn_started" && "turnId" in response.scope ? { turn: { turnId: response.scope.turnId } } : {}),
    };
  }
  private buildEnvelope(commandId: string, input: InternalCommand): RelayCodexCommandMessage {
    const host = () => this.options.scopes.resolveHostScope(); const launch = () => required(this.options.scopes.resolveProfileLaunchScope); const profile = () => required(this.options.scopes.resolveProfileScope); const binding = () => required(this.options.scopes.resolveBindingScope); const turn = () => required(this.options.scopes.resolveTurnScope);
    switch (input.operation) {
      case "runtime_inspect": return { type: "relay:codex-command", commandId, scope: host(), command: { kind: "runtime_inspect" } };
      case "runtime_install": return { type: "relay:codex-command", commandId, scope: host(), command: { kind: "runtime_install", artifactRef: input.artifactRef } };
      case "runtime_cancel_install": return { type: "relay:codex-command", commandId, scope: host(), command: { kind: "runtime_cancel_install", installRef: input.installRef } };
      case "runtime_activate": return { type: "relay:codex-command", commandId, scope: host(), command: { kind: "runtime_activate", runtimeGeneration: input.runtimeGeneration } };
      case "runtime_rollback": return { type: "relay:codex-command", commandId, scope: host(), command: { kind: "runtime_rollback" } };
      case "runtime_remove": return { type: "relay:codex-command", commandId, scope: host(), command: { kind: "runtime_remove", runtimeGeneration: input.runtimeGeneration } };
      case "profile_create": return { type: "relay:codex-command", commandId, scope: host(), command: { kind: "profile_create", profileHandle: input.profileHandle, profileGeneration: input.profileGeneration } };
      case "profile_remove": { const scope = launch(); if (scope.profileHandle !== input.profileHandle || scope.profileGeneration !== input.profileGeneration) throw new Error("CODEX_CONTEXT_STALE"); return { type: "relay:codex-command", commandId, scope, command: { kind: "profile_remove", profileHandle: input.profileHandle, profileGeneration: input.profileGeneration } }; }
      case "account_login_start": return { type: "relay:codex-command", commandId, scope: profile(), command: { kind: "account_login_start" } };
      case "account_login_cancel": return { type: "relay:codex-command", commandId, scope: profile(), command: { kind: "account_login_cancel", loginRef: input.loginRef } };
      case "account_read": return { type: "relay:codex-command", commandId, scope: profile(), command: { kind: "account_read" } };
      case "account_logout": return { type: "relay:codex-command", commandId, scope: profile(), command: { kind: "account_logout" } };
      case "account_rate_limits_read": return { type: "relay:codex-command", commandId, scope: profile(), command: { kind: "account_rate_limits_read" } };
      case "account_usage_read": return { type: "relay:codex-command", commandId, scope: profile(), command: { kind: "account_usage_read" } };
      case "model_list": return { type: "relay:codex-command", commandId, scope: profile(), command: { kind: "model_list" } };
      case "ensure_profile_child": return { type: "relay:codex-command", commandId, scope: launch(), command: { kind: "ensure_profile_child", posture: posture(input.posture) } };
      case "open_binding": return { type: "relay:codex-command", commandId, scope: required(this.options.scopes.resolveBindingOpenScope), command: { kind: "open_binding", ...(input.model === undefined ? {} : { model: input.model }), posture: posture(input.posture), ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }) } };
      case "rebind_binding": { const pair = required(this.options.scopes.resolveRebindScopes); return { type: "relay:codex-command", commandId, scope: pair.current, command: { kind: "rebind_binding", nextBindingGeneration: pair.successor.bindingGeneration, successorWorkspace: pair.successor.workspace } }; }
      case "resume_binding": return { type: "relay:codex-command", commandId, scope: binding(), command: { kind: "resume_binding" } };
      case "release_binding": return { type: "relay:codex-command", commandId, scope: binding(), command: { kind: "release_binding" } };
      case "start_turn": return { type: "relay:codex-command", commandId, scope: binding(), command: { kind: "start_turn", userText: input.userText, turnInputRef: this.mintId(), ...(input.collaborationMode === "plan" ? { collaborationMode: "plan" as const } : {}) } };
      case "steer_turn": return { type: "relay:codex-command", commandId, scope: turn(), command: { kind: "steer_turn", userText: input.userText, actorRef: input.actorRef } };
      case "interrupt_turn": return { type: "relay:codex-command", commandId, scope: turn(), command: { kind: "interrupt_turn", reason: input.reason } };
      case "drain_profile": return { type: "relay:codex-command", commandId, scope: profile(), command: { kind: "drain_profile", deadlineAt: input.deadlineAt } };
      case "terminate_child": return { type: "relay:codex-command", commandId, scope: profile(), command: { kind: "terminate_child", reason: input.reason } };
    }
  }
}
function required<T>(resolver: (() => T) | undefined): T { if (!resolver) throw new Error("CODEX_CONTEXT_INVALID"); return resolver(); }
