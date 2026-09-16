import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface PhotoLibraryRecoveryAuditEvent {
  readonly ts: string;
  readonly kind: "photo_library_recovery";
  readonly actorId: string | null;
  readonly ip: "local";
  readonly action: "dry_run" | "apply";
  readonly outcome: "would_adopt" | "adopted" | "already_adopted" | "refused";
  readonly operationId: string;
  readonly serverInstanceId: string;
  readonly operatorUserId: string;
  readonly ownerUserId: string;
  readonly agentId: string;
  readonly avatarKind: "generated" | "uploaded";
  readonly blobId: string;
  readonly mediaByteSize?: number;
  readonly mediaSha256?: string;
  readonly reason?: string;
}

/**
 * Write the operator-only recovery trail to its own durable local JSONL file.
 * It is deliberately not part of SecurityAuditEvent, so the ordinary server
 * audit API cannot disclose quarantined blob identifiers.
 */
export function writePhotoLibraryRecoveryAuditEvent(
  path: string,
  event: PhotoLibraryRecoveryAuditEvent,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
