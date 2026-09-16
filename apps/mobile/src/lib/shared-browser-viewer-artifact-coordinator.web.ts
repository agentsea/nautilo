import { ApiError } from "@nautilo/api-client/browser";

import { ensureValidToken } from "@/lib/auth";
import { emitAuthDead } from "@/lib/auth-events";

import type {
  AcquireBrowserArtifactInput,
  BrowserArtifactAcquisition,
} from "./shared-browser-viewer-artifact-coordinator-contract";
import {
  acquireBrowserArtifactViewerBytes,
  BrowserArtifactByteSourceError,
} from "./shared-browser-viewer-byte-source.web";

export * from "./shared-browser-viewer-artifact-coordinator-contract";

type ProtectedPhase<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "auth_dead" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly error: unknown };

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

function hasValidInput(input: AcquireBrowserArtifactInput): boolean {
  return input.serverId.trim().length > 0
    && input.baseUrl.trim().length > 0
    && input.artifactId.trim().length > 0
    && (input.roomId === undefined || input.roomId.trim().length > 0)
    && Number.isSafeInteger(input.maxBytes)
    && input.maxBytes > 0;
}

function mapApiError(error: ApiError): BrowserArtifactAcquisition {
  switch (error.status) {
    case 403: return { kind: "forbidden" };
    case 404: return { kind: "not_found" };
    case 501: return { kind: "not_implemented" };
    default: return { kind: "server", status: error.status };
  }
}

/**
 * Run one protected request phase using the shared platform auth authority.
 * A 401 gets one forced refresh for this phase only; no other error retries.
 */
async function runProtectedPhase<T>(
  input: AcquireBrowserArtifactInput,
  operation: () => Promise<T>,
): Promise<ProtectedPhase<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (input.signal.aborted) return { kind: "cancelled" };
    let token: string | null;
    try {
      token = await ensureValidToken(input.serverId, input.baseUrl, { forceRefresh: attempt === 1 });
    } catch (error) {
      return isAbort(error, input.signal) ? { kind: "cancelled" } : { kind: "error", error };
    }
    if (input.signal.aborted) return { kind: "cancelled" };
    if (!token) {
      emitAuthDead(input.serverId);
      return { kind: "auth_dead" };
    }
    input.client.setToken(token);
    try {
      return { kind: "value", value: await operation() };
    } catch (error) {
      if (isAbort(error, input.signal)) return { kind: "cancelled" };
      if (error instanceof ApiError && error.status === 401 && attempt === 0) continue;
      if (error instanceof ApiError && error.status === 401) {
        emitAuthDead(input.serverId);
        return { kind: "auth_dead" };
      }
      return { kind: "error", error };
    }
  }
  emitAuthDead(input.serverId);
  return { kind: "auth_dead" };
}

function mapPhaseFailure(
  phase: Extract<ProtectedPhase<never>, { readonly kind: "error" }>,
  fallback: "metadata" | "bytes",
): BrowserArtifactAcquisition {
  return phase.error instanceof ApiError ? mapApiError(phase.error) : { kind: "unavailable", reason: fallback };
}

/**
 * Acquire canonical metadata then one exact bounded ArrayBuffer for Mobile Web.
 * It neither renders bytes nor creates Blob/object URL state.
 */
export async function acquireBrowserArtifact(
  input: AcquireBrowserArtifactInput,
): Promise<BrowserArtifactAcquisition> {
  if (input.signal.aborted) return { kind: "cancelled" };
  if (!hasValidInput(input)) return { kind: "invalid_input" };

  const metadataPhase = await runProtectedPhase(input, () => input.client.getWorkspaceArtifact(
    input.artifactId,
    input.roomId === undefined ? undefined : { roomId: input.roomId },
  ));
  if (metadataPhase.kind === "cancelled" || metadataPhase.kind === "auth_dead") return metadataPhase;
  if (metadataPhase.kind === "error") return mapPhaseFailure(metadataPhase, "metadata");
  const artifact = metadataPhase.value;
  if (artifact === null) return { kind: "not_found" };
  if (artifact.id !== input.artifactId || !Number.isSafeInteger(artifact.size) || artifact.size < 0) {
    return { kind: "unavailable", reason: "integrity" };
  }
  if (artifact.size > input.maxBytes) {
    return { kind: "too_large", artifact, declaredBytes: artifact.size, maxBytes: input.maxBytes };
  }
  if (input.signal.aborted) return { kind: "cancelled" };

  const bytesPhase = await runProtectedPhase(input, () => acquireBrowserArtifactViewerBytes({
    client: input.client,
    artifactId: input.artifactId,
    artifact,
    ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
    maxBytes: input.maxBytes,
    signal: input.signal,
  }));
  if (bytesPhase.kind === "cancelled" || bytesPhase.kind === "auth_dead") return bytesPhase;
  if (bytesPhase.kind === "error") {
    if (bytesPhase.error instanceof BrowserArtifactByteSourceError) {
      if (bytesPhase.error.code === "size") {
        return { kind: "too_large", artifact, declaredBytes: artifact.size, maxBytes: input.maxBytes };
      }
      return { kind: "unavailable", reason: "integrity" };
    }
    return mapPhaseFailure(bytesPhase, "bytes");
  }
  return { kind: "ready", ...bytesPhase.value };
}
