import { useEffect, useMemo, useRef, useState } from "react";
import {
  deriveExactAnchoredTextPatch,
  type HumanEditLeaseCandidateTarget,
  type HumanEditLeaseRecord,
  type HumanEditLeaseState,
} from "@nautilo/types";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { useAuth } from "../hooks/use-auth";
import { getDesktopLocalHumanEditLeaseAPI, getDesktopRelayId } from "../lib/desktop";
import { apiClient } from "../lib/api";
import type { PatchEditorStatus } from "./use-patch-document-session";
import {
  HumanEditLeaseSession,
  type HumanEditLeaseDesiredState,
} from "./human-edit-lease-session";

const HEARTBEAT_MS = 20_000;

export function humanEditLeaseTransportRoute(
  kind: HumanEditLeaseCandidateTarget["kind"],
): "workspace" | "desktop" {
  return kind === "workspace_artifact" ? "workspace" : "desktop";
}

function newEditorSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `human-edit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Workspace artifacts keep their existing HTTP registry. Local files never
 * transit the server: the Desktop preload routes them to the process that owns
 * the guarded filesystem, local coordinator, and local lease registry.
 */
const humanEditLeaseTransport = {
  registerHumanEditLease: async (request: Parameters<typeof apiClient.registerHumanEditLease>[0], opts?: {
    roomId?: string;
    targetKind?: HumanEditLeaseCandidateTarget["kind"];
  }) => {
    if (humanEditLeaseTransportRoute(request.target.kind) === "workspace") {
      return await apiClient.registerHumanEditLease(request, opts?.roomId === undefined ? undefined : { roomId: opts.roomId });
    }
    const local = getDesktopLocalHumanEditLeaseAPI();
    if (!local) throw new Error("Desktop local human-edit lease IPC is unavailable");
    return await local.register(request);
  },
  updateHumanEditLease: async (leaseId: string, request: Parameters<typeof apiClient.updateHumanEditLease>[1], opts?: {
    roomId?: string;
    targetKind?: HumanEditLeaseCandidateTarget["kind"];
  }) => {
    if (humanEditLeaseTransportRoute(request.target.kind) === "workspace") {
      return await apiClient.updateHumanEditLease(leaseId, request, opts?.roomId === undefined ? undefined : { roomId: opts.roomId });
    }
    const local = getDesktopLocalHumanEditLeaseAPI();
    if (!local) throw new Error("Desktop local human-edit lease IPC is unavailable");
    return await local.update(leaseId, request);
  },
  renewHumanEditLease: async (leaseId: string, request: Parameters<typeof apiClient.renewHumanEditLease>[1], opts?: {
    roomId?: string;
    targetKind?: HumanEditLeaseCandidateTarget["kind"];
  }) => {
    if (humanEditLeaseTransportRoute(request.target.kind) === "workspace") {
      return await apiClient.renewHumanEditLease(leaseId, request, opts?.roomId === undefined ? undefined : { roomId: opts.roomId });
    }
    const local = getDesktopLocalHumanEditLeaseAPI();
    if (!local) throw new Error("Desktop local human-edit lease IPC is unavailable");
    return await local.renew(leaseId, request);
  },
  releaseHumanEditLease: async (leaseId: string, request: Parameters<typeof apiClient.releaseHumanEditLease>[1], opts?: {
    targetKind?: HumanEditLeaseCandidateTarget["kind"];
  }) => {
    if (opts?.targetKind === undefined || humanEditLeaseTransportRoute(opts.targetKind) === "workspace") {
      return await apiClient.releaseHumanEditLease(leaseId, request);
    }
    const local = getDesktopLocalHumanEditLeaseAPI();
    if (!local) throw new Error("Desktop local human-edit lease IPC is unavailable");
    return await local.release(leaseId, request);
  },
};

export function humanEditLeaseStateForEditor(input: {
  status: PatchEditorStatus;
  dirty: boolean;
}): HumanEditLeaseState {
  if (input.status === "patching") return "saving";
  if (input.status === "conflict") return "conflict";
  if ((input.status === "idle" || input.status === "saved") && !input.dirty) return "clean";
  return input.dirty ? "dirty" : "clean";
}

export type UseHumanEditLeaseInput = {
  file: OpenFileTarget;
  baseContent: string;
  draft: string;
  dirty: boolean;
  status: PatchEditorStatus;
};

export type PublishedHumanEditState = {
  state: HumanEditLeaseState;
  draftPatch?: HumanEditLeaseDesiredState["draftPatch"];
};

type ResourceBoundHumanEditLeaseTarget = {
  resourceKey: string;
  target: HumanEditLeaseCandidateTarget;
};

export function humanEditLeaseTargetForResource(
  value: ResourceBoundHumanEditLeaseTarget | null,
  resourceKey: string,
): HumanEditLeaseCandidateTarget | null {
  return value?.resourceKey === resourceKey ? value.target : null;
}

/**
 * Best-effort lease observation for the shared text editor. This hook never
 * awaits a lease request from a change/save path; it only retains the newest
 * editor truth for its serialized background session to publish later.
 */
export function useHumanEditLease(input: UseHumanEditLeaseInput): {
  record: HumanEditLeaseRecord | null;
} {
  const state = humanEditLeaseStateForEditor({ status: input.status, dirty: input.dirty });
  const update = useMemo<PublishedHumanEditState>(() => {
    const draftPatch = state === "clean"
      ? undefined
      : deriveExactAnchoredTextPatch(input.baseContent, input.draft) ?? undefined;
    return {
      state,
      ...(draftPatch !== undefined ? { draftPatch } : {}),
    };
  }, [input.baseContent, input.draft, state]);
  return usePublishedHumanEditLease({
    file: input.file,
    update,
  });
}

/**
 * Host-side publisher for first-party mini-app draft truth. `file` is always
 * supplied by the surface binding; the iframe can never choose its target.
 */
export function usePublishedHumanEditLease(input: {
  file?: OpenFileTarget;
  update: PublishedHumanEditState;
}): {
  record: HumanEditLeaseRecord | null;
} {
  const auth = useAuth();
  const sessionRef = useRef<HumanEditLeaseSession | null>(null);
  const [record, setRecord] = useState<HumanEditLeaseRecord | null>(null);
  const [boundTarget, setBoundTarget] = useState<ResourceBoundHumanEditLeaseTarget | null>(null);
  const fileKind = input.file?.kind;
  const filePath = input.file?.path;
  const artifactInternalId = input.file?.kind === "artifact" ? input.file.id : null;
  const resourceKey = input.file === undefined
    ? null
    :
    fileKind === "artifact"
      ? `artifact:${artifactInternalId ?? ""}:${filePath}`
      : `local:${filePath}`;
  const authScope =
    auth.viewer.isVerified && auth.viewer.sessionUserId
      ? `${auth.viewer.sessionUserId}:${auth.viewerGeneration}:${resourceKey ?? "unbound"}`
      : null;

  useEffect(() => {
    setRecord(null);
    setBoundTarget(null);
    if (authScope === null || resourceKey === null) return;

    const session = new HumanEditLeaseSession({
      transport: humanEditLeaseTransport,
      sessionId: newEditorSessionId(),
      onRecord: setRecord,
      // Leases are advisory. Keeping the error out of editor state is
      // deliberate: an outage must not turn a successful local save into UI
      // failure or block another autosave.
      onError: () => undefined,
    });
    sessionRef.current = session;
    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      session.release();
    };
  }, [authScope, resourceKey]);

  useEffect(() => {
    if (authScope === null || resourceKey === null || filePath === undefined) return;
    let cancelled = false;
    if (fileKind === "artifact" && artifactInternalId !== null) {
      setBoundTarget({
        resourceKey,
        target: {
          kind: "workspace_artifact",
          artifactInternalId,
          logicalPath: filePath,
        },
      });
      return;
    }
    void getDesktopRelayId().then((relayId) => {
      if (cancelled || relayId === null) return;
      setBoundTarget({
        resourceKey,
        target: {
          kind: "local_file",
          relayId,
          candidatePath: filePath,
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [artifactInternalId, authScope, fileKind, filePath, resourceKey]);

  const desired = useMemo<HumanEditLeaseDesiredState | null>(() => {
    if (resourceKey === null) return null;
    const target = humanEditLeaseTargetForResource(boundTarget, resourceKey);
    if (target === null) return null;
    return {
      target,
      state: input.update.state,
      ...(input.update.draftPatch !== undefined ? { draftPatch: input.update.draftPatch } : {}),
      ...(input.file?.kind === "artifact" && input.file.roomId !== undefined
        ? { roomId: input.file.roomId }
        : {}),
    };
  }, [boundTarget, input.file, input.update.draftPatch, input.update.state, resourceKey]);

  useEffect(() => {
    if (desired === null) return;
    sessionRef.current?.setDesired(desired);
  }, [desired]);

  useEffect(() => {
    if (authScope === null) return;
    const wake = () => sessionRef.current?.wake();
    const heartbeat = window.setInterval(() => sessionRef.current?.heartbeat(), HEARTBEAT_MS);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [authScope]);

  return { record };
}
