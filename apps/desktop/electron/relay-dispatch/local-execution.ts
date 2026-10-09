import { isLocalExecutionReadArgs } from "@nautilo/types";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  parseRelayLocalExecutionBinding,
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type RelayLocalExecutionOwnerV1,
  type RelayLocalExecutionBindingV2,
  type RelayLocalExecutionBindingV3,
  type RelayLocalExecutionBindingV4,
  type RelayWorkstationShellBinding,
} from "@nautilo/relay";
import type { LocalExecutionHost, LocalExecutionSnapshot } from "../local-execution-host";
import type { PreparedLocalExecution } from "../local-execution-process";
import { RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES } from "../run-shell-output-continuity";

export function localExecutionOwnerKey(owner: RelayLocalExecutionOwnerV1): string {
  return JSON.stringify([
    owner.instanceId, owner.humanUserId, owner.agentId, owner.runId, owner.conversationId,
    owner.relayId, owner.desktopSessionId, owner.pairingGeneration, owner.serverBindingId,
    owner.profileId, owner.profileRevision, [...owner.grantIds].sort(),
    owner.grantRevision, owner.protectedPolicyVersion,
  ]);
}

export type LocalExecutionAuthority = RelayWorkstationShellBinding | RelayLocalExecutionBindingV2 | RelayLocalExecutionBindingV3 | RelayLocalExecutionBindingV4;

export type LocalExecutionView = LocalExecutionSnapshot & { generation: string; session_id: string };
export interface LocalExecutionViewRequest {
  generation: string;
  executionId: string;
  cursor: number;
  maxBytes: number;
}

function integer(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("LOCAL_EXECUTION_ARGUMENT_INVALID");
  }
  return value;
}

/** One adapter belongs to the same authenticated Desktop session as its host. */
export class LocalExecutionDispatch {
  private readonly owners = new Map<string, string>();
  private readonly historyOwners = new Map<string, RelayLocalExecutionOwnerV1>();
  private readonly authorities = new Map<string, LocalExecutionAuthority>();
  private readonly identities = new Map<string, { validate?: () => Promise<void>; containedRoot?: string; containedGrantIds?: readonly string[] }>();
  constructor(readonly host: LocalExecutionHost) {}

  private withHistoryOwner<T>(binding: { executionId: string; owner: RelayLocalExecutionOwnerV1 }, admit: () => T): T {
    const added = !this.historyOwners.has(binding.executionId);
    if (added) this.historyOwners.set(binding.executionId, structuredClone(binding.owner));
    try { return admit(); }
    catch (error) { if (added) this.historyOwners.delete(binding.executionId); throw error; }
  }

  attachHistoryWriter(write: (owner: RelayLocalExecutionOwnerV1, view: LocalExecutionView) => Promise<void>): void {
    this.host.subscribeSettled(async (snapshot, ownerKey) => {
      const owner = this.historyOwners.get(snapshot.executionId);
      if (owner !== undefined && localExecutionOwnerKey(owner) === ownerKey) await write(owner, this.view(snapshot));
    });
  }

  private view(snapshot: LocalExecutionSnapshot): LocalExecutionView {
    return { ...snapshot, generation: this.host.hostGeneration, session_id: snapshot.executionId };
  }

  async dispatch(input: {
    request: RelayDispatchRequest;
    signal?: AbortSignal | undefined;
    revalidate: (binding: LocalExecutionAuthority, retained: boolean) => Promise<void>;
    prepare: (signal: AbortSignal) => Promise<PreparedLocalExecution & { validateContinuation?: () => Promise<void>; containedRoot?: string; containedGrantIds?: readonly string[] }>;
  }): Promise<RelayDispatchResult> {
    const req = input.request;
    try {
      const binding = parseRelayLocalExecutionBinding(req.localExecutionBinding);
      if (binding === null) throw new Error("LOCAL_EXECUTION_BINDING_INVALID");
      if (binding.generation !== this.host.hostGeneration) throw new Error("LOCAL_EXECUTION_GENERATION_MISMATCH");
      const authenticated = req.runShellOwnerBinding;
      if (authenticated === undefined ||
          authenticated.instanceId !== binding.owner.instanceId ||
          authenticated.userId !== binding.owner.humanUserId ||
          authenticated.relayId !== binding.owner.relayId ||
          authenticated.desktopSessionId !== binding.owner.desktopSessionId) {
        throw new Error("LOCAL_EXECUTION_OWNER_MISMATCH");
      }
      const authority = binding.version !== 1 ? binding : req.workstationShellBinding;
      const args = req.args;
      const start = req.toolName === "exec_command";
      if (!start && req.toolName !== "write_stdin") throw new Error("LOCAL_EXECUTION_TOOL_INVALID");
      const allowed = new Set(start
        ? ["cmd", "workdir", "tty", "yield_time_ms", "max_output_bytes"]
        : ["session_id", "chars", "cursor", "yield_time_ms", "max_output_bytes", "cancel", "search"]);
      if (Object.keys(args).some((key) => !allowed.has(key))) throw new Error("LOCAL_EXECUTION_ARGUMENT_INVALID");
      if (args["chars"] !== undefined && typeof args["chars"] !== "string") throw new Error("LOCAL_EXECUTION_ARGUMENT_INVALID");
      if (args["cancel"] !== undefined && typeof args["cancel"] !== "boolean") throw new Error("LOCAL_EXECUTION_ARGUMENT_INVALID");
      if (args["cancel"] === true && args["chars"] !== undefined) throw new Error("LOCAL_EXECUTION_ARGUMENT_INVALID");
      if (args["search"] !== undefined && (start || !isLocalExecutionReadArgs(args))) throw new Error("LOCAL_EXECUTION_ARGUMENT_INVALID");
      const operation = start ? "start" : args["cancel"] === true ? "cancel" : args["chars"] ? "input" : "read";
      if (operation !== binding.operation || (!start && args["session_id"] !== binding.executionId)) {
        throw new Error("LOCAL_EXECUTION_OPERATION_MISMATCH");
      }
      const ownerKey = localExecutionOwnerKey(binding.owner);
      const read = {
        executionId: binding.executionId, ownerKey,
        cursor: integer(args["cursor"], 0),
        maxBytes: integer(args["max_output_bytes"], RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES),
        // Zero is a response default, never a process deadline.
        yieldMs: integer(args["yield_time_ms"], 0),
      };
      if (read.maxBytes < 4 || read.yieldMs > 2 ** 31 - 1) throw new Error("LOCAL_EXECUTION_ARGUMENT_INVALID");
      if (operation === "read" || operation === "input") {
        const retained = this.authorities.get(binding.executionId);
        if (retained !== undefined) {
          const retainedManaged = "authority" in retained;
          if (retainedManaged !== (binding.version !== 1)
            || (retainedManaged && binding.version !== 1
              && (retained.version !== binding.version || JSON.stringify(retained.authority) !== JSON.stringify(binding.authority)))) {
            throw new Error("LOCAL_EXECUTION_AUTHORITY_MISMATCH");
          }
        }
      }
      if (start || operation === "input") {
        const shell = req.workstationShellBinding;
        if (binding.version === 1 && (shell === undefined || shell.profileId !== binding.owner.profileId ||
            shell.profileRevision !== binding.owner.profileRevision ||
            shell.serverBindingId !== binding.owner.serverBindingId ||
            shell.grantRevision !== binding.owner.grantRevision ||
            shell.protectedPolicyVersion !== binding.owner.protectedPolicyVersion ||
            JSON.stringify([...shell.grantIds].sort()) !== JSON.stringify([...binding.owner.grantIds].sort()))) {
          throw new Error("LOCAL_EXECUTION_AUTHORITY_MISMATCH");
        }
        if (binding.version !== 1 && shell !== undefined) throw new Error("LOCAL_EXECUTION_AUTHORITY_MISMATCH");
        if (binding.version === 3 && (args["tty"] === true || operation === "input"
          || req.executionClass !== "real_workstation" || req.uncontainedHostCommandsSession !== true || !req.approvalObtained)) {
          throw new Error("LOCAL_EXECUTION_FULL_MAC_ONE_SHOT_REQUIRED");
        }
        if (binding.version !== 3 && (req.executionClass === "real_workstation" || req.uncontainedHostCommandsSession)) {
          throw new Error("LOCAL_EXECUTION_REQUIRES_CONTAINMENT");
        }
        const retained = operation === "input" ? this.authorities.get(binding.executionId) : undefined;
        if (operation === "input") {
          if (retained === undefined || this.owners.get(binding.executionId) !== ownerKey) throw new Error("LOCAL_EXECUTION_OWNER_MISMATCH");
          await this.identities.get(binding.executionId)?.validate?.();
        }
        // First admission is reserved below before its asynchronous policy
        // check. Repeated starts still need fresh authority to read a receipt.
        if (!start || this.owners.has(binding.executionId)) {
          await input.revalidate(retained ?? authority!, operation === "input");
        }
      }
      if (operation === "read") {
        const authority = this.authorities.get(binding.executionId);
        if (authority === undefined || this.owners.get(binding.executionId) !== ownerKey) throw new Error("LOCAL_EXECUTION_UNAVAILABLE");
        await this.identities.get(binding.executionId)?.validate?.();
        await input.revalidate(authority, true);
      }
      if (start) {
        if (typeof args["cmd"] !== "string" || args["cmd"].trim() === "" ||
            (args["tty"] !== undefined && typeof args["tty"] !== "boolean") ||
            (args["workdir"] !== undefined && typeof args["workdir"] !== "string")) {
          throw new Error("LOCAL_EXECUTION_ARGUMENT_INVALID");
        }
        if (req.impact === "destructive" && !req.approvalObtained) throw new Error("LOCAL_EXECUTION_APPROVAL_REQUIRED");
        const fingerprint = createHash("sha256").update(JSON.stringify([
          args["cmd"], args["workdir"] ?? null, args["tty"] === true, binding.version !== 1 ? binding.authority : null,
        ])).digest("hex");
        this.withHistoryOwner(binding, () => this.host.start({
          executionId: binding.executionId, requestIdentity: binding.invocationId,
          requestFingerprint: fingerprint, ownerKey, hostGeneration: binding.generation,
          tty: args["tty"] === true, prepare: async (signal) => {
            await input.revalidate(authority!, false);
            // Human Stop may have fenced the reserved execution while the
            // policy check was pending. Do not create sandbox resources then.
            if (signal.aborted) throw new Error("LOCAL_EXECUTION_CANCELLED");
            const prepared = await input.prepare(signal);
            if (prepared.validateContinuation !== undefined || prepared.containedRoot !== undefined) this.identities.set(binding.executionId, {
              ...(prepared.validateContinuation ? { validate: prepared.validateContinuation } : {}),
              ...(prepared.containedRoot ? { containedRoot: prepared.containedRoot } : {}),
              ...(prepared.containedGrantIds ? { containedGrantIds: [...prepared.containedGrantIds] } : {}),
            });
            return prepared;
          }, signal: input.signal,
        }));
        if (!this.owners.has(binding.executionId)) this.owners.set(binding.executionId, ownerKey);
        if (!this.authorities.has(binding.executionId)) this.authorities.set(binding.executionId, authority!);
      }
      if (operation === "cancel" && !this.historyOwners.has(binding.executionId)) {
        this.withHistoryOwner(binding, () => this.host.reserveCancellation({ ...read, hostGeneration: binding.generation }));
      }
      if (typeof args["search"] === "string") {
        const result = this.host.search({ executionId: read.executionId, ownerKey, cursor: read.cursor, maxBytes: read.maxBytes, literal: args["search"] });
        return { status: "ok", result: { ...this.view(result.snapshot), search: result.search } };
      }
      const snapshot = operation === "cancel" ? await this.host.cancelOrReserve({ ...read, hostGeneration: binding.generation })
        : operation === "input" ? await this.host.write({ ...read, inputId: binding.invocationId, chars: args["chars"] as string })
          : await this.host.read(read);
      if (operation === "cancel") this.owners.set(binding.executionId, ownerKey);
      return { status: "ok", result: this.view(snapshot) };
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const errorCode = /^(?:LOCAL_EXECUTION_|WORKSTATION_SHELL_|GRANT_|PROFILE_BINDING_|CURRENT_FOLDER_|CAPABILITY_REVISION_|PROTECTED_POLICY_VERSION_|SUBJECT_|RELAY_|DESKTOP_SESSION_|IDENTITY_|OPERATION_)[A-Z_]+$/.test(code)
        ? code : "LOCAL_EXECUTION_FAILED";
      return { status: "error", errorCode, error: errorCode };
    }
  }

  /** Invoked only behind Electron's active-main-renderer sender guard. */
  async humanRead(request: LocalExecutionViewRequest, cancel = false): Promise<LocalExecutionView> {
    if (request.generation !== this.host.hostGeneration) throw new Error("LOCAL_EXECUTION_GENERATION_MISMATCH");
    const ownerKey = this.owners.get(request.executionId);
    if (ownerKey === undefined) throw new Error("LOCAL_EXECUTION_NOT_FOUND");
    const read = { ...request, ownerKey, yieldMs: 0 };
    return this.view(await (cancel ? this.host.cancel(read) : this.host.read(read)));
  }

  /** Temporary account authority ends on transport loss, including after yield. */
  fenceFullMac(): void {
    for (const [executionId, ownerKey] of this.owners) {
      const authority = this.authorities.get(executionId);
      if (authority && "authority" in authority && authority.version === 3) {
        this.host.reserveCancellation({ executionId, ownerKey, hostGeneration: this.host.hostGeneration });
      }
    }
  }

  /** A disconnected server can no longer deliver Task/source revocation. */
  fenceDelegated(): void {
    for (const [executionId, ownerKey] of this.owners) {
      const authority = this.authorities.get(executionId);
      if (authority && "authority" in authority && authority.version === 4) {
        this.host.reserveCancellation({ executionId, ownerKey, hostGeneration: this.host.hostGeneration });
      }
    }
  }

  /** Includes reserved work and uncertain cleanup; released history is not a writer. */
  retainedContainedRoots(): readonly string[] {
    const roots = new Set<string>();
    for (const [executionId, ownerKey] of this.owners) {
      const custody = this.host.getCustodyState(executionId, ownerKey);
      if (custody?.resources === "released" && custody.state !== "unknown") continue;
      const authority = this.authorities.get(executionId);
      if (!authority || ("authority" in authority && authority.version === 3)) continue;
      const root = "authority" in authority
        ? authority.version === 4 ? this.identities.get(executionId)?.containedRoot : authority.authority.currentFolder
        : authority.currentFolder;
      if (root) roots.add(root);
    }
    return [...roots].sort();
  }

  retainedContainedGrantIds(): readonly string[] {
    const ids = new Set<string>();
    for (const [executionId, ownerKey] of this.owners) {
      const custody = this.host.getCustodyState(executionId, ownerKey);
      if (custody?.resources === "released" && custody.state !== "unknown") continue;
      const authority = this.authorities.get(executionId);
      for (const id of this.identities.get(executionId)?.containedGrantIds ?? []) ids.add(id);
      if (authority && !("authority" in authority)) for (const id of authority.grantIds) ids.add(id);
      if (authority && "authority" in authority && authority.version === 4) ids.add(authority.authority.delegation.projectGrantId);
    }
    return [...ids].sort();
  }

  /** Profile reduction never cancels Basic executions owned by this host. */
  fenceDevelopment(): void {
    for (const [executionId, ownerKey] of this.owners) {
      const authority = this.authorities.get(executionId);
      if (authority && (!("authority" in authority) || (authority.version === 4 && authority.authority.delegation.ceiling === "development"))) {
        this.host.reserveCancellation({ executionId, ownerKey, hostGeneration: this.host.hostGeneration });
      }
    }
  }

  fenceAll(grantId?: string, revokedRoot?: string): void {
    for (const [executionId, ownerKey] of this.owners) {
      const authority = this.authorities.get(executionId);
      const root = authority === undefined ? undefined : !("authority" in authority) ? authority.currentFolder
        : authority.version === 2 ? authority.authority.currentFolder
          : authority.version === 4 ? this.identities.get(executionId)?.containedRoot : undefined;
      const relative = revokedRoot === undefined || root === undefined ? undefined : path.relative(revokedRoot, root);
      const rootMatches = relative !== undefined && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
      if (grantId === undefined) this.host.fenceOwner(ownerKey);
      else if (this.identities.get(executionId)?.containedGrantIds?.includes(grantId)
        || (authority !== undefined && !("authority" in authority) && authority.grantIds.includes(grantId))
        || (authority !== undefined && "authority" in authority && authority.version === 4 && authority.authority.delegation.projectGrantId === grantId) || rootMatches) {
        this.host.reserveCancellation({ executionId, ownerKey, hostGeneration: this.host.hostGeneration });
      }
    }
  }
}
