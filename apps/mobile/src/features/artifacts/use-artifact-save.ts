import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";
import FileExport, { isFileExportAvailable, isMediaExportAvailable } from "../../../modules/nautilo-file-export";
import { isMediaLibraryCandidate } from "./artifact-media-export";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useArtifactEvents } from "@/providers/artifact-events";
import { viewerConvergenceAction } from "./artifact-convergence";
import { nativeSaveFailureCopy } from "./artifact-save-feedback";
import { nativeExportMimeType, type ArtifactOriginalExportScope } from "./artifact-original-export";
import { acquireAuthorizedArtifactOriginal } from "./artifact-original-access";
import { canShareOriginalFile, shareOriginalFile } from "@/lib/original-file-share";

type SaveState = Readonly<{
  phase: "idle" | "preparing" | "destination" | "cancelling" | "saved" | "handoff" | "cancelled" | "failed";
  message: string;
}>;

/** Native saving is a separate operation; renderer support and edit rights are not inputs. */
export function useArtifactSave() {
  const { activeServer } = useServers();
  const { viewer, status } = useAuth();
  const { subscribe } = useArtifactEvents();
  const identity = JSON.stringify([activeServer?.id, activeServer?.serverUrl, viewer?.userId, status]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mounted = useRef(true);
  const pending = useRef<{ scope: ArtifactOriginalExportScope; controller: AbortController; identity: string; requestId: string } | null>(null);
  const generation = useRef(0);
  const [state, setState] = useState<SaveState>({ phase: "idle", message: "" });
  const cancel = useCallback(() => {
    const operation = pending.current;
    if (!operation) return;
    operation.controller.abort();
    // The native operation retains ownership until its picker/copy callback
    // settles. Never delete a source out from under an active native copy.
    void FileExport.cancelPendingExportAsync(operation.requestId).catch(() => {});
    if (mounted.current && operation.identity === identityRef.current) {
      setState({ phase: "cancelling", message: "Cancelling… Close the save or share dialog if it is still open." });
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  useEffect(() => {
    if (pending.current && pending.current.identity !== identity) {
      cancel();
      setState({ phase: "cancelling", message: "Cancelling the previous account's save. Close its save dialog if it is still open." });
    } else if (!pending.current) setState({ phase: "idle", message: "" });
  }, [identity, cancel]);
  useEffect(() => subscribe((event) => {
    if (viewerConvergenceAction(event, pending.current?.scope.sourceId, false) !== "none") cancel();
  }), [subscribe, cancel]);

  const save = useCallback(async (artifactId: string, destination: "file" | "media" | "share" = "file"): Promise<void> => {
    if (pending.current || !activeServer || !viewer || status !== "signed-in") return;
    if (destination === "share" && !canShareOriginalFile()) {
      setState({ phase: "failed", message: "Save the file first, then share it from your device's Files app." });
      return;
    }
    if (!isFileExportAvailable() || (destination === "media" && !isMediaExportAvailable())) {
      setState({ phase: "failed", message: "Saving files requires an updated Nautilo iPhone or Android build." });
      return;
    }
    const controller = new AbortController();
    const scope: ArtifactOriginalExportScope = {
      serverId: activeServer.id, accountId: viewer.userId,
      sourceKind: "artifact", sourceId: artifactId, generation: ++generation.current,
    };
    const operation = { scope, controller, identity, requestId: randomUUID() };
    pending.current = operation;
    const isCurrent = (): boolean => mounted.current && pending.current === operation && identityRef.current === identity;
    const signal = controller.signal;
    let cleanup: (() => void | Promise<void>) | undefined;
    let savedFilename: string | undefined;
    setState({ phase: "preparing", message: "Preparing original file…" });

    try {
      await FileExport.prepareExportCacheAsync();
      if (!isCurrent() || signal.aborted) {
        if (isCurrent()) setState({ phase: "cancelled", message: "Save cancelled." });
        return;
      }
      const acquired = await acquireAuthorizedArtifactOriginal({ scope, baseUrl: activeServer.serverUrl, isCurrent, controller });
      if (acquired.kind === "failed") {
        if (isCurrent()) setState(acquired.reason === "cancelled"
          ? { phase: "cancelled", message: "Save cancelled." }
          : { phase: "failed", message: exportFailureCopy(acquired.reason) });
        return;
      }
      cleanup = acquired.cleanup;
      if (!isCurrent() || signal.aborted) {
        if (isCurrent()) setState({ phase: "cancelled", message: "Save cancelled." });
        return;
      }
      // The pre/post metadata check is not immutable-revision proof. This
      // working vertical must pass the tracked byte-consistency release gate.
      if (destination === "share") {
        setState({ phase: "destination", message: "Choose an app to share the original with. Close the share sheet to cancel." });
        await shareOriginalFile(acquired.fileUri, nativeExportMimeType(acquired.mimeType));
        if (isCurrent()) setState({ phase: "handoff", message: "Share sheet closed. Check the receiving app to confirm your copy." });
        return;
      }
      if (destination === "media" && !isMediaLibraryCandidate(acquired.mimeType)) {
        setState({ phase: "failed", message: "This file cannot be added to your photo library. Use Save file instead." });
        return;
      }
      setState({ phase: "destination", message: destination === "media" ? "Saving to your photo library…" : "Choose where to save the original file." });
      const input = {
        requestId: operation.requestId, fileUri: acquired.fileUri, filename: acquired.filename, mimeType: nativeExportMimeType(acquired.mimeType),
      };
      const receipt = destination === "media" ? await FileExport.saveMediaAsync(input) : await FileExport.saveFileAsync(input);
      if (receipt.status === "saved") savedFilename = acquired.filename;
      if (isCurrent()) setState(receipt.status === "saved"
        ? { phase: "saved", message: destination === "media" ? `Saved to your photo library: ${acquired.filename}` : `Saved: ${acquired.filename}` }
        : { phase: "cancelled", message: "Save cancelled." });
    } catch (error) {
      if (isCurrent()) setState({ phase: "failed", message: destination === "share"
        ? "Could not open sharing. You can try again or use Save file instead."
        : nativeSaveFailureCopy(error) });
    } finally {
      try { await cleanup?.(); }
      catch {
        if (isCurrent()) setState({ phase: "failed", message: savedFilename
          ? `Saved: ${savedFilename}. The temporary app copy could not be removed.`
          : "The temporary app copy could not be removed." });
      }
      if (pending.current === operation) {
        pending.current = null;
        if (mounted.current && identityRef.current !== identity) {
          setState({ phase: "cancelled", message: "The previous save operation has ended." });
        }
      }
    }
  }, [activeServer, identity, status, viewer]);

  return { state, save, cancel, busy: state.phase === "preparing" || state.phase === "destination" || state.phase === "cancelling" };
}

function exportFailureCopy(reason: string): string {
  switch (reason) {
    case "auth_dead": return "Your session ended. Sign in again before saving.";
    case "forbidden": return "This account cannot save this file. Check its access on the server.";
    case "missing": return "This file is no longer available.";
    case "cleanup_failed": return "The file was not saved, and a temporary app copy could not be removed.";
    case "source_changed": case "invalid_scope": return "The file or account changed. Try saving again.";
    default: return "Could not prepare the original file. Check your connection and storage, then try again.";
  }
}
