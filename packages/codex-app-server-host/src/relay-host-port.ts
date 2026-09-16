import type {
  BindingOpenScope,
  BindingIdentityScope,
  BindingScope,
  CodexPosture as RelayCodexPosture,
  ProfileLaunchScope,
  TurnScope,
  WorkspaceReceipt as RelayWorkspaceReceipt,
} from "@nautilo/relay";
import { isCodexRelayProtocolVersion } from "@nautilo/relay";
import type {
  BindingRequest,
  BindingResumeRequest,
  BoundThread,
  ChildIdentity,
  OpaqueHandle,
  SupervisorRequest,
  WorkspaceReceipt,
} from "./contracts";
import { CodexProfileSupervisor } from "./supervisor";

/**
 * Electron's relay adapter owns the mapping from v8+ `workspaceRef` to the
 * host-local receipt table. This keeps v8 wire strings from becoming paths.
 */
export interface AuthenticatedRelayAdmissionResolver {
  /** Atomically resolves the authenticated actor and host-local receipt snapshot. */
  resolve(scope: ProfileLaunchScope, receipt: RelayWorkspaceReceipt): Promise<{ readonly actorId: string; readonly workspace: WorkspaceReceipt }>;
}

export interface CodexWorkingDirectoryResolver {
  /** Resolves an optional Task request on the selected host; never grants access. */
  resolve(requested: string | undefined): Promise<string>;
}

/** Thin typed adapter; it does not interpret postures or invoke Nautilo tools. */
export class CodexRelayHostPort {
  constructor(
    private readonly supervisor: CodexProfileSupervisor,
    private readonly admission: AuthenticatedRelayAdmissionResolver,
    private readonly workingDirectories: CodexWorkingDirectoryResolver,
  ) {}

  async ensure(scope: ProfileLaunchScope, workspace: RelayWorkspaceReceipt): Promise<ChildIdentity> {
    return this.supervisor.ensure(await this.request(scope, workspace));
  }

  async open(scope: BindingOpenScope, input: { readonly posture: RelayCodexPosture; readonly model?: string; readonly workingDirectory?: string }): Promise<BoundThread> {
    const request = await this.request(scope, scope.workspace);
    const workingDirectory = await this.workingDirectories.resolve(input.workingDirectory);
    return this.supervisor.open(request, {
      bindingId: scope.bindingId as OpaqueHandle,
      bindingGeneration: scope.bindingGeneration,
      workspace: request.workspace,
      taskId: scope.taskId,
      jobId: scope.jobId,
      workingDirectory,
      model: input.model,
      posture: postureFrom(input.posture),
    });
  }

  async resume(scope: BindingScope): Promise<BoundThread> {
    const request = await this.request(scope, scope.workspace);
    return this.supervisor.resume(request, resumeFrom(scope, request.workspace));
  }

  /** Releases only the exact authenticated binding that was previously opened. */
  async release(scope: BindingScope): Promise<void> {
    const request = await this.request(scope, scope.workspace);
    await this.supervisor.releaseBindingExact(
      {
        profile: request.profile,
        accountGeneration: request.accountGeneration,
        runtimeGeneration: request.runtimeGeneration,
        childGeneration: scope.childGeneration,
      },
      resumeFrom(scope, request.workspace),
    );
  }

  async rebind(scope: BindingIdentityScope, successorWorkspace: RelayWorkspaceReceipt, nextBindingGeneration: number): Promise<BoundThread> {
    const request = await this.request(scope, successorWorkspace);
    return this.supervisor.rebind(request, {
      bindingId: scope.bindingId as OpaqueHandle,
      bindingGeneration: scope.bindingGeneration,
      taskId: scope.taskId,
      jobId: scope.jobId,
      threadId: scope.threadId,
      successorWorkspace: request.workspace,
      nextBindingGeneration,
    });
  }

  async start(
    scope: BindingScope,
    input: {
      readonly text: string;
      readonly clientUserMessageId: string;
      readonly collaborationMode: "work" | "plan";
    },
  ): Promise<{ readonly turnId: string }> {
    const request = await this.request(scope, scope.workspace);
    return this.supervisor.startTurn(
      request,
      resumeFrom(scope, request.workspace),
      input,
    );
  }

  /** Turns are admitted only after the exact task/job/thread BindingScope has been resumed. */
  async interrupt(scope: TurnScope): Promise<void> {
    const request = await this.request(scope, scope.workspace);
    // An active turn must not be resumed before it is interrupted: app-server
    // may be blocked on an out-of-band elicitation for that very turn. The
    // authenticated TurnScope already carries its exact child/binding/turn
    // authority, and supervisor.interrupt revalidates all three fail-closed.
    await this.supervisor.interrupt(
      {
        profile: request.profile,
        accountGeneration: request.accountGeneration,
        runtimeGeneration: request.runtimeGeneration,
        childGeneration: scope.childGeneration,
      },
      scope.bindingId as OpaqueHandle,
      scope.turnId,
    );
  }

  /** Same-turn steering is guarded by the authenticated exact TurnScope. */
  async steer(
    scope: TurnScope,
    input: { readonly text: string; readonly actorRef: string },
  ): Promise<void> {
    const request = await this.request(scope, scope.workspace);
    await this.supervisor.steer(
      {
        profile: request.profile,
        accountGeneration: request.accountGeneration,
        runtimeGeneration: request.runtimeGeneration,
        childGeneration: scope.childGeneration,
      },
      scope.bindingId as OpaqueHandle,
      scope.turnId,
      {
        text: input.text,
        clientUserMessageId: input.actorRef,
      },
    );
  }

  private async request(scope: ProfileLaunchScope, wireReceipt: RelayWorkspaceReceipt): Promise<SupervisorRequest> {
    if (!isCodexRelayProtocolVersion(scope.selectedProtocolVersion)) {
      throw new Error("Codex host requires the relay protocol v8+ family");
    }
    const { actorId, workspace } = await this.admission.resolve(scope, wireReceipt);
    const request = {
      profile: {
        actorId,
        profileHandle: scope.profileHandle as OpaqueHandle,
        profileGeneration: scope.profileGeneration,
      },
      accountGeneration: scope.accountGeneration,
      runtimeGeneration: scope.runtimeGeneration,
      workspace,
    };
    if (actorId !== workspace.actorId || workspace.relayId !== scope.relayId || workspace.relaySessionId !== scope.relaySessionId || workspace.desktopSessionId !== scope.desktopSessionId || workspace.pairingGenerationRef !== scope.pairingGenerationRef || workspace.capabilityRevision !== scope.capabilityRevision) {
      throw new Error("Relay scope does not match host-local workspace receipt");
    }
    return request;
  }

}

function resumeFrom(scope: BindingScope, workspace: WorkspaceReceipt): BindingResumeRequest {
  return {
    bindingId: scope.bindingId as OpaqueHandle,
    bindingGeneration: scope.bindingGeneration,
    workspace,
    taskId: scope.taskId,
    jobId: scope.jobId,
    threadId: scope.threadId,
  };
}

function postureFrom(posture: RelayCodexPosture): BindingRequest["posture"] {
  switch (posture.kind) {
    case "codex_default": return Object.freeze({ kind: "codex_default" });
    case "prompted_workspace": return Object.freeze({ kind: "prompted_workspace" });
    case "full_access_headless": return Object.freeze({ kind: "full_access_headless" });
  }
}
