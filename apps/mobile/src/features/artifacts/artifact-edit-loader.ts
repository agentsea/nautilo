import { ApiError, type ArtifactDto, type NautiloApiClient } from "@nautilo/api-client/browser";
import * as Crypto from "expo-crypto";

import {
  admitArtifactEditContent,
  preflightArtifactEdit,
  type ArtifactEditContentAdmission,
} from "./artifact-edit-admission";
import { ensureValidToken } from "@/lib/auth";
import { emitAuthDead } from "@/lib/auth-events";
import { downloadArtifactBytes } from "@/lib/artifact-byte-download";

export type ArtifactEditLoadResult =
  | { kind: "not-found" }
  | { kind: "cancelled" }
  | { kind: "auth-dead" }
  | { kind: "forbidden" }
  | { kind: "network" }
  | { kind: "view-only"; admission: Extract<ArtifactEditContentAdmission, { kind: "view-only" }> }
  | { kind: "ready"; artifact: ArtifactDto; baseSha256: string; admission: Exclude<ArtifactEditContentAdmission, { kind: "view-only" }> };

function metadata(artifact: ArtifactDto) {
  return {
    path: artifact.path,
    mimeType: artifact.mimeType,
    size: artifact.size,
    writable: artifact.canWrite,
  };
}

export async function loadArtifactForEdit(input: {
  client: Pick<NautiloApiClient, "getWorkspaceArtifact" | "getWorkspaceArtifactBytesUrl" | "setToken">;
  artifactId: string;
  serverId: string;
  baseUrl: string;
  sourceContent?: string;
  signal?: AbortSignal;
}): Promise<ArtifactEditLoadResult> {
  let artifact: ArtifactDto | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ensureValidToken(input.serverId, input.baseUrl, {
      forceRefresh: attempt === 1,
    });
    if (!token) {
      emitAuthDead(input.serverId);
      return { kind: "auth-dead" };
    }
    if (input.signal?.aborted) return { kind: "cancelled" };
    input.client.setToken(token);
    try {
      artifact = await input.client.getWorkspaceArtifact(input.artifactId);
      break;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && attempt === 0) continue;
      if (error instanceof ApiError && error.status === 401) {
        emitAuthDead(input.serverId);
        return { kind: "auth-dead" };
      }
      if (error instanceof ApiError && error.status === 403) return { kind: "forbidden" };
      return { kind: "network" };
    }
  }
  if (!artifact) return { kind: "not-found" };
  const admission = preflightArtifactEdit(metadata(artifact));
  if (admission.kind === "view-only") return { kind: "view-only", admission };
  let content = input.sourceContent;
  if (content === undefined) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await ensureValidToken(input.serverId, input.baseUrl, {
        forceRefresh: attempt === 1,
      });
      if (!token) {
        emitAuthDead(input.serverId);
        return { kind: "auth-dead" };
      }
      if (input.signal?.aborted) return { kind: "cancelled" };
      try {
        const downloaded = await downloadArtifactBytes({
          url: input.client.getWorkspaceArtifactBytesUrl(input.artifactId),
          token,
          cacheName: `${artifact.id}-${artifact.revision}.txt`,
          text: true,
          signal: input.signal,
        });
        if (downloaded.kind !== "text") return { kind: "network" };
        content = downloaded.content;
        break;
      } catch (error) {
        if (input.signal?.aborted) return { kind: "cancelled" };
        const status = Number(
          (error instanceof Error ? error.message : String(error))
            .match(/(?:http|status)[:\s]*(\d{3})/i)?.[1],
        );
        if (status === 401 && attempt === 0) continue;
        if (status === 401) {
          emitAuthDead(input.serverId);
          return { kind: "auth-dead" };
        }
        if (status === 403) return { kind: "forbidden" };
        if (status === 404) return { kind: "not-found" };
        return { kind: "network" };
      }
    }
    if (content === undefined) return { kind: "network" };
    if (input.signal?.aborted) return { kind: "cancelled" };
  }
  const accepted = admitArtifactEditContent(metadata(artifact), content);
  if (accepted.kind === "view-only") return { kind: "view-only", admission: accepted };
  try {
    const baseSha256 = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      content,
      { encoding: Crypto.CryptoEncoding.HEX },
    );
    if (input.signal?.aborted) return { kind: "cancelled" };
    return { kind: "ready", artifact, baseSha256, admission: accepted };
  } catch {
    return { kind: "network" };
  }
}
