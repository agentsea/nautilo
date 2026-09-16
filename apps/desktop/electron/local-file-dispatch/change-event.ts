/**
 * M206 — RelayFsChangeEvent helpers for local-file mutations.
 */

import * as path from "node:path";
import type { RelayFsChangeEvent, RelayFsOp } from "@nautilo/relay";
import type { LocalRoutingContext } from "./paths.ts";

export function ipcPayloadFromRelayFsChange(event: RelayFsChangeEvent): RelayFsChangeEvent {
  return {
    rootPath: event.rootPath,
    path: event.path,
    changedPath: event.changedPath,
    source: event.source,
    op: event.op,
    ...(event.reloadRequired !== undefined ? { reloadRequired: event.reloadRequired } : {}),
    ...(event.sha256 ? { sha256: event.sha256 } : {}),
    ...(event.clientMutationId ? { clientMutationId: event.clientMutationId } : {}),
    ...(event.patchEvent ? { patchEvent: event.patchEvent } : {}),
  };
}

export function changeEventForMutation(args: {
  rootPath: string;
  changedPath: string;
  op: RelayFsOp;
  sha256?: string | undefined;
  reloadRequired?: boolean | undefined;
  clientMutationId?: string | undefined;
}): RelayFsChangeEvent {
  return {
    rootPath: args.rootPath,
    path: path.dirname(args.changedPath),
    changedPath: args.changedPath,
    source: "relay",
    op: args.op,
    ...(args.sha256 ? { sha256: args.sha256 } : {}),
    ...(args.reloadRequired ? { reloadRequired: true } : {}),
    ...(args.clientMutationId ? { clientMutationId: args.clientMutationId } : {}),
  };
}

export function rootPathForZone(
  zone: "current" | "absolute",
  resolved: string,
  routing: LocalRoutingContext,
): string {
  if (zone === "current" && routing.currentFolder) {
    return routing.currentFolder;
  }
  return path.dirname(resolved);
}
