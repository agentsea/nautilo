import { ApiError } from "@nautilo/api-client/browser";
import { type DecryptProfileBundleResult, type semantic } from "@nautilo/profile-portability";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { apiClient } from "../../../lib/api";
import {
  createProfileBundleBrowserCrypto,
  decryptBrowserProfileBundle,
  disposeDecryptedProfileBundle,
  encryptBrowserProfileBundle,
  wipeProfileBundleSecret,
} from "../../../lib/profile-bundle-browser";
import { Button } from "../ui";

type Mode = "download" | "restore";

interface OperationProgress {
  readonly title: string;
  readonly steps: readonly string[];
  readonly stepIndex: number;
  readonly startedAt: number;
}

interface PreparedRestore {
  readonly bundle: semantic.GenieLiveV1;
  readonly avatarBytes: Uint8Array | null;
  readonly avatarMedia: { readonly mediaEntry: string; readonly mimeType: string } | null;
  readonly plan: Awaited<ReturnType<typeof apiClient.planProfileBundleImport>>["plan"];
  /** Staging is plan-local; do not create another spool after an uncertain commit response. */
  readonly avatarStaged: boolean;
  /** Kept for an uncertain response; a retry cannot create a second restore. */
  readonly idempotencyKey: string;
  /** Once commit starts, retries must reuse the exact plan and idempotency key. */
  readonly commitAttempted: boolean;
}

type AvatarImportChoice = "backup" | "current";

function hasUnsupportedArtifacts(bundle: Readonly<{
  scopes: readonly semantic.PortableScope[];
  records: readonly semantic.SemanticRecord[];
}>): boolean {
  return bundle.scopes.includes("privateArtifacts")
    || bundle.records.some((record) => record.recordKind === "artifact");
}

function readableError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) return "Your sign-in no longer has access. Sign in again, then try once more.";
    if (cause.status >= 500) return "The server could not complete that request. Nothing has been changed; try again shortly.";
  }
  if (cause instanceof Error) return cause.message;
  return fallback;
}

function isStaleOrExpired(cause: unknown): boolean {
  return cause instanceof ApiError
    && (cause.status === 410 || /stale|expired|fresh/i.test(cause.message));
}

function triggerDownload(contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "nautilo-genie-backup.nautilo-profile.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function countPrivateMemories(records: readonly semantic.SemanticRecord[]): number {
  return records.filter((record) => record.recordKind === "memory" && record.scope === "private").length;
}

function identityName(bundle: semantic.GenieLiveV1): string {
  const identity = bundle.records.find((record) => record.recordKind === "identity");
  return identity?.recordKind === "identity" ? identity.name : "";
}

function withImportIdentity(
  bundle: semantic.GenieLiveV1,
  name: string,
  avatarChoice: AvatarImportChoice,
): semantic.GenieLiveV1 {
  const records = bundle.records.map((record): semantic.SemanticRecord => {
    if (record.recordKind === "identity") {
      return {
        ...record,
        name,
        // An edited display name should not silently retain the backup's
        // customized handle. Let the target derive a matching local handle.
        handleIntent: name === record.name ? record.handleIntent : null,
      };
    }
    if (record.recordKind === "avatar" && avatarChoice === "current") {
      // The server interprets absent avatar media as "preserve current".
      return { recordKind: "avatar", avatar: null };
    }
    return record;
  });
  return { ...bundle, records } as semantic.GenieLiveV1;
}

/**
 * The personal-Agent-only backup journey. The portable data contract remains
 * shared with the CLI, but all encryption and file handling stays in this
 * browser page. The server receives only semantic data and raw avatar bytes.
 */
export function GenieBackupRestore({ onRestored }: Readonly<{
  onRestored: () => Promise<void> | void;
}>) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<PreparedRestore | null>(null);
  const preparedRef = useRef<PreparedRestore | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [needsReviewAgain, setNeedsReviewAgain] = useState(false);
  const [restoreName, setRestoreName] = useState("");
  const [avatarChoice, setAvatarChoice] = useState<AvatarImportChoice>("current");
  const [backupAvatarUrl, setBackupAvatarUrl] = useState<string | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const replacePrepared = (next: PreparedRestore | null) => {
    const previous = preparedRef.current;
    // Re-planning retains the same decrypted avatar buffer. Only wipe it when
    // ownership genuinely moves away (close, success, or a newly selected file).
    if (previous?.avatarBytes && previous.avatarBytes !== next?.avatarBytes) previous.avatarBytes.fill(0);
    preparedRef.current = next;
    setPrepared(next);
  };

  const clearSensitiveState = useCallback(() => {
    replacePrepared(null);
    setPassword("");
    setPasswordConfirmation("");
    setSelectedFile(null);
    setRestoreName("");
    setAvatarChoice("current");
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const beginProgress = (title: string, steps: readonly string[], stepIndex = 0) => {
    setElapsedSeconds(0);
    setProgress({ title, steps, stepIndex, startedAt: Date.now() });
  };

  const advanceProgress = (stepIndex: number) => {
    setProgress((current) => current ? { ...current, stepIndex } : current);
  };

  const close = useCallback(() => {
    if (busy) return;
    clearSensitiveState();
    setMode(null);
    setError(null);
    setNotice(null);
    setProgress(null);
    setNeedsReviewAgain(false);
  }, [busy, clearSensitiveState]);

  useEffect(() => () => {
    preparedRef.current?.avatarBytes?.fill(0);
  }, []);

  useEffect(() => {
    if (!prepared?.avatarBytes || !prepared.avatarMedia) {
      setBackupAvatarUrl(null);
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(new Blob(
        [prepared.avatarBytes.slice()],
        { type: prepared.avatarMedia.mimeType },
      ));
    } catch {
      setBackupAvatarUrl(null);
      return;
    }
    setBackupAvatarUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [prepared?.avatarBytes, prepared?.avatarMedia]);

  useEffect(() => {
    if (!mode) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(null);
    setNotice(null);
    setNeedsReviewAgain(false);
    window.setTimeout(() => {
      if (mode === "restore") fileRef.current?.focus();
      else passwordRef.current?.focus();
    });
    return () => previousFocus.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (!error) return;
    window.setTimeout(() => errorRef.current?.focus(), 0);
  }, [error]);

  const progressStartedAt = progress?.startedAt;
  useEffect(() => {
    if (progressStartedAt === undefined) return;
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - progressStartedAt) / 1000));
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [progressStartedAt]);

  useEffect(() => {
    if (!mode) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = closeRef.current?.closest<HTMLElement>("[role=dialog]");
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [href]") ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [busy, close, mode]);

  const open = (next: Mode) => {
    clearSensitiveState();
    setMode(next);
  };

  async function downloadBackup(): Promise<void> {
    if (password.length === 0) { setError("Enter a backup password."); return; }
    if (password !== passwordConfirmation) { setError("The two backup passwords do not match."); return; }
    setBusy(true);
    setError(null);
    setNotice(null);
    beginProgress("Preparing your backup", ["Collect Genie data", "Encrypt on this device", "Save the backup file"]);
    const passphrase = new TextEncoder().encode(password);
    const cryptoAdapter = createProfileBundleBrowserCrypto();
    let avatarBytes: Uint8Array | null = null;
    try {
      const exported = await apiClient.exportProfileBundle();
      if (hasUnsupportedArtifacts({ scopes: exported.scopes, records: exported.records })) {
        throw new Error("This Genie has artifacts that Backup & restore cannot include yet. Nothing was downloaded.");
      }
      if (exported.avatarMedia) {
        avatarBytes = new Uint8Array(await (await apiClient.downloadProfileBundleMedia(exported.avatarMedia.mediaEntry)).arrayBuffer());
      }
      advanceProgress(1);
      const encrypted = await encryptBrowserProfileBundle({
        bundleId: exported.bundleId,
        records: exported.records,
        avatarBytes,
        avatarMedia: exported.avatarMedia,
        passphrase,
      }, cryptoAdapter);
      advanceProgress(2);
      triggerDownload(encrypted);
      const memoryCount = countPrivateMemories(exported.records);
      setNotice(`Downloaded an encrypted backup with your profile${exported.avatarMedia ? ", avatar" : ""}, and ${memoryCount} private ${memoryCount === 1 ? "memory" : "memories"}.`);
      setPassword("");
      setPasswordConfirmation("");
    } catch (cause) {
      setError(readableError(cause, "Your backup could not be downloaded."));
    } finally {
      avatarBytes?.fill(0);
      wipeProfileBundleSecret(passphrase);
      cryptoAdapter.dispose();
      setProgress(null);
      setBusy(false);
    }
  }

  async function reviewRestore(): Promise<void> {
    if (!selectedFile) { setError("Choose your backup file first."); return; }
    if (!password) { setError("Enter the backup password."); return; }
    setBusy(true);
    setError(null);
    setNotice(null);
    setNeedsReviewAgain(false);
    beginProgress("Checking your backup", ["Read the backup file", "Unlock on this device", "Check what will change"]);
    const passphrase = new TextEncoder().encode(password);
    const cryptoAdapter = createProfileBundleBrowserCrypto();
    let decrypted: DecryptProfileBundleResult | null = null;
    try {
      const fileText = await selectedFile.text();
      advanceProgress(1);
      decrypted = await decryptBrowserProfileBundle(fileText, passphrase, cryptoAdapter);
      if (hasUnsupportedArtifacts(decrypted.bundle)) {
        throw new Error("This backup contains artifacts and cannot be restored here yet.");
      }
      advanceProgress(2);
      const whoami = await apiClient.whoami();
      const response = await apiClient.planProfileBundleImport({
        bundle: decrypted.bundle,
        destinationInstanceId: whoami.instanceId,
        scopes: decrypted.bundle.scopes,
        wholeProfileChoice: "source",
      });
      if (response.plan.privateArtifactCount > 0 || response.plan.refused.length > 0 || response.plan.unknown.length > 0) {
        throw new Error("This backup includes data that Backup & restore cannot safely restore here yet.");
      }
      const next: PreparedRestore = {
        bundle: decrypted.bundle,
        avatarBytes: decrypted.avatarBytes,
        avatarMedia: decrypted.avatarMedia,
        plan: response.plan,
        idempotencyKey: crypto.randomUUID(),
        avatarStaged: false,
        commitAttempted: false,
      };
      setRestoreName(identityName(decrypted.bundle));
      setAvatarChoice(decrypted.avatarBytes && decrypted.avatarMedia ? "backup" : "current");
      replacePrepared(next);
      disposeDecryptedProfileBundle(decrypted);
      decrypted = null; // avatar bytes now have explicit PreparedRestore ownership.
      setPassword("");
      setSelectedFile(null);
    } catch (cause) {
      setError(readableError(cause, "This backup could not be checked on this Genie."));
    } finally {
      if (decrypted) disposeDecryptedProfileBundle(decrypted);
      wipeProfileBundleSecret(passphrase);
      cryptoAdapter.dispose();
      setProgress(null);
      setBusy(false);
    }
  }

  async function reviewAgain(): Promise<void> {
    if (!prepared) return;
    setBusy(true);
    setError(null);
    beginProgress("Refreshing the review", ["Check this Genie", "Refresh the change summary"]);
    try {
      const whoami = await apiClient.whoami();
      advanceProgress(1);
      const chosenBundle = withImportIdentity(prepared.bundle, restoreName.trim(), avatarChoice);
      const response = await apiClient.planProfileBundleImport({
        bundle: chosenBundle,
        destinationInstanceId: whoami.instanceId,
        scopes: prepared.bundle.scopes,
        wholeProfileChoice: "source",
      });
      if (response.plan.privateArtifactCount > 0 || response.plan.refused.length > 0 || response.plan.unknown.length > 0) {
        throw new Error("This backup includes data that Backup & restore cannot safely restore here yet.");
      }
      replacePrepared({ ...prepared, plan: response.plan, idempotencyKey: crypto.randomUUID(), avatarStaged: false, commitAttempted: false });
      setNeedsReviewAgain(false);
    } catch (cause) {
      setError(readableError(cause, "The backup could not be reviewed again."));
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function restoreBackup(): Promise<void> {
    if (!prepared) return;
    const chosenName = restoreName.trim();
    if (!chosenName) { setError("Enter a name for this Genie."); return; }
    setBusy(true);
    setError(null);
    setNotice(null);
    const hasAvatar = avatarChoice === "backup" && Boolean(prepared.avatarBytes && prepared.avatarMedia);
    const needsChoicePlan = !prepared.commitAttempted;
    const needsAvatarStage = hasAvatar && !prepared.avatarStaged;
    const steps = [
      ...(needsChoicePlan ? ["Confirm name and avatar"] : []),
      ...(needsAvatarStage ? ["Prepare the avatar"] : []),
      "Merge profile and memories",
      "Refresh this Genie",
    ];
    beginProgress("Restoring your backup", steps);
    let commitRequested = false;
    try {
      let current = prepared;
      let completedSteps = 0;
      if (needsChoicePlan) {
        const chosenBundle = withImportIdentity(current.bundle, chosenName, avatarChoice);
        const whoami = await apiClient.whoami();
        const response = await apiClient.planProfileBundleImport({
          bundle: chosenBundle,
          destinationInstanceId: whoami.instanceId,
          scopes: chosenBundle.scopes,
          wholeProfileChoice: "source",
        });
        if (response.plan.privateArtifactCount > 0 || response.plan.refused.length > 0 || response.plan.unknown.length > 0) {
          throw new Error("These import choices cannot be applied safely.");
        }
        current = {
          ...current,
          plan: response.plan,
          idempotencyKey: crypto.randomUUID(),
          avatarStaged: false,
          commitAttempted: true,
        };
        replacePrepared(current);
        advanceProgress(++completedSteps);
      }
      if (needsAvatarStage && current.avatarBytes && current.avatarMedia) {
        const bytes = current.avatarBytes.slice();
        try {
          await apiClient.stageProfileBundleAvatar({
            planToken: current.plan.planToken,
            mediaEntry: current.avatarMedia.mediaEntry,
            bytes: new Blob([bytes], { type: current.avatarMedia.mimeType }),
          });
        } finally {
          bytes.fill(0);
        }
        current = { ...current, avatarStaged: true };
        replacePrepared(current);
        advanceProgress(++completedSteps);
      }
      commitRequested = true;
      const committed = await apiClient.commitProfileBundleImport({
        planToken: current.plan.planToken,
        idempotencyKey: current.idempotencyKey,
      });
      advanceProgress(++completedSteps);
      await onRestored();
      window.dispatchEvent(new Event("nautilo:profile-changed"));
      setNotice(`Backup restored. ${committed.privateMemoryAddedCount} private ${committed.privateMemoryAddedCount === 1 ? "memory was" : "memories were"} added; ${committed.privateMemoryAlreadyPresentCount} ${committed.privateMemoryAlreadyPresentCount === 1 ? "was" : "were"} already present.`);
      replacePrepared(null);
      setMode("restore");
    } catch (cause) {
      if (isStaleOrExpired(cause)) {
        setNeedsReviewAgain(true);
        setError("This Genie changed while the backup was waiting. Review it again before restoring; your file is still checked locally.");
      } else if (cause instanceof ApiError && cause.status === 409 && /handle|collision/i.test(cause.message)) {
        setError("This Genie name is already in use here. Change the name on this Genie, then review the backup again.");
      } else if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
        setError("Your sign-in no longer has access. Sign in again, then review the backup again.");
      } else if (commitRequested && (!(cause instanceof ApiError) || cause.status >= 500)) {
        setError("We could not confirm whether the restore finished. Try Restore again; it uses the same safe retry key and will not duplicate memories.");
      } else if (cause instanceof ApiError) {
        setError("This restore was declined by the server. Close this window and review the backup again, or choose a different backup.");
      } else {
        setError(readableError(cause, "The backup could not be prepared for restore. Nothing has been changed; try again."));
      }
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  const plan = prepared?.plan;
  return (
    <section className="mt-5 border-t border-border/40 pt-4" aria-labelledby="genie-backup-restore-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h4 id="genie-backup-restore-title" className="text-sm font-medium text-foreground">Backup &amp; restore</h4>
          <p className="mt-1 max-w-xl text-xs text-foreground-muted">Keep an encrypted copy of this Genie&apos;s name, personality, voice settings, avatar, and private memories. The password stays on this device.</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button onClick={() => open("download")}>Download backup</Button>
          <Button onClick={() => open("restore")}>Restore backup</Button>
        </div>
      </div>
      {mode ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="genie-backup-dialog-title" aria-describedby="genie-backup-dialog-description" aria-busy={busy}>
          <div className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-border-strong bg-background-panel p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="genie-backup-dialog-title" className="text-base font-semibold">{progress?.title ?? (notice ? (mode === "download" ? "Backup downloaded" : "Backup restored") : mode === "download" ? "Download backup" : prepared ? "Review backup" : "Restore backup")}</h2>
                <p id="genie-backup-dialog-description" className="mt-1 text-sm text-foreground-muted">{progress ? "You can leave this window open while Nautilo finishes." : notice ? "This step is complete." : mode === "download" ? "Choose a password to protect a local backup file." : prepared ? "Confirm the changes to this Genie." : "Choose your encrypted backup file and enter its password."}</p>
              </div>
              <button ref={closeRef} type="button" onClick={close} disabled={busy} aria-label="Close backup and restore" className="rounded p-1 text-foreground-muted hover:text-foreground disabled:opacity-50">✕</button>
            </div>
            {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="mt-4 rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)] outline-none">{error}</p> : null}
            {busy && progress ? (
              <ProgressPanel progress={progress} elapsedSeconds={elapsedSeconds} />
            ) : notice ? (
              <div className="mt-5 space-y-5">
                <div className="rounded-lg border border-primary/40 bg-primary/10 p-4" role="status">
                  <div className="flex items-start gap-3"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground" aria-hidden="true">✓</span><p className="pt-0.5 text-sm text-foreground">{notice}</p></div>
                </div>
                <div className="flex justify-end gap-2"><Button onClick={() => { setNotice(null); window.setTimeout(() => mode === "download" ? passwordRef.current?.focus() : fileRef.current?.focus(), 0); }} variant="ghost">{mode === "download" ? "Download another" : "Restore another"}</Button><Button onClick={close} variant="primary">Done</Button></div>
              </div>
            ) : mode === "download" ? (
              <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void downloadBackup(); }}>
                <PasswordField inputRef={passwordRef} value={password} onChange={setPassword} show={showPassword} onShow={setShowPassword} label="Backup password" confirmation={false} autoComplete="new-password" disabled={busy} />
                <PasswordField value={passwordConfirmation} onChange={setPasswordConfirmation} show={showPassword} onShow={setShowPassword} label="Confirm backup password" confirmation autoComplete="new-password" disabled={busy} />
                <p className="text-xs text-foreground-muted">If you lose this password, this backup cannot be opened.</p>
                <div className="flex justify-end gap-2"><Button onClick={close} disabled={busy} variant="ghost">Cancel</Button><Button type="submit" loading={busy} variant="primary">Download backup</Button></div>
              </form>
            ) : prepared && plan ? (
              <div className="mt-4 space-y-4">
                <dl className="space-y-2 rounded-md border border-border bg-background-element/50 p-3 text-sm">
                  <div><dt><label htmlFor="genie-restore-name" className="text-foreground-muted">Genie name</label></dt><dd><input id="genie-restore-name" value={restoreName} onChange={(event) => setRestoreName(event.currentTarget.value)} disabled={busy || prepared.commitAttempted} required className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-primary disabled:opacity-60" /></dd></div>
                  <div className="pt-1"><dt className="text-foreground-muted">Avatar</dt><dd className="mt-2 space-y-2 text-foreground">
                    {plan.avatarMedia ? <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-2"><input type="radio" name="genie-restore-avatar" value="backup" checked={avatarChoice === "backup"} onChange={() => setAvatarChoice("backup")} disabled={busy || prepared.commitAttempted} />{backupAvatarUrl ? <img src={backupAvatarUrl} alt="Backed-up avatar" className="size-10 rounded-lg object-cover" /> : null}<span>Use backed-up avatar</span></label> : null}
                    <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-2"><input type="radio" name="genie-restore-avatar" value="current" checked={avatarChoice === "current"} onChange={() => setAvatarChoice("current")} disabled={busy || prepared.commitAttempted} /><span>Keep current avatar</span></label>
                    {!plan.avatarMedia ? <p className="text-xs text-foreground-muted">This backup has no avatar. Your current avatar will be kept.</p> : null}
                  </dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-foreground-muted">Private memories</dt><dd className="text-right">Merge: {plan.privateMemoryAddedCount} new, {plan.privateMemoryAlreadyPresentCount} already here</dd></div>
                </dl>
                <p className="text-xs text-foreground-muted">Restore never deletes or overwrites existing private memories. Exact matches are kept once; none of their content is shown here.</p>
                {prepared.commitAttempted ? <p className="text-xs text-foreground-muted">Name and avatar are locked while Nautilo safely retries this restore.</p> : null}
                <div className="flex justify-end gap-2"><Button onClick={close} disabled={busy} variant="ghost">Cancel</Button>{needsReviewAgain ? <Button onClick={() => void reviewAgain()} loading={busy} variant="primary">Review again</Button> : <Button onClick={() => void restoreBackup()} loading={busy} variant="primary">Restore backup</Button>}</div>
              </div>
            ) : (
              <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void reviewRestore(); }}>
                <div><label htmlFor="genie-backup-file" className="block text-sm font-medium text-foreground">Backup file</label><input ref={fileRef} id="genie-backup-file" type="file" disabled={busy} onChange={(event) => setSelectedFile(event.currentTarget.files?.[0] ?? null)} className="mt-1 block w-full text-sm text-foreground-muted file:mr-3 file:rounded-md file:border-0 file:bg-background-element file:px-3 file:py-1.5 file:text-sm file:text-foreground hover:file:bg-background" /><p className="mt-1 text-xs text-foreground-muted">Choose the encrypted backup file Nautilo downloaded.</p></div>
                <PasswordField inputRef={passwordRef} value={password} onChange={setPassword} show={showPassword} onShow={setShowPassword} label="Backup password" confirmation={false} autoComplete="current-password" disabled={busy} />
                <div className="flex justify-end gap-2"><Button onClick={close} disabled={busy} variant="ghost">Cancel</Button><Button type="submit" loading={busy} variant="primary">Review backup</Button></div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProgressPanel({ progress, elapsedSeconds }: Readonly<{
  progress: OperationProgress;
  elapsedSeconds: number;
}>) {
  const currentStep = progress.stepIndex + 1;
  return (
    <div className="mt-5 space-y-4" role="status" aria-live="polite">
      <div className="h-2 overflow-hidden rounded-full bg-background-element" role="progressbar" aria-label={progress.title} aria-valuemin={1} aria-valuemax={progress.steps.length} aria-valuenow={currentStep} aria-valuetext={`Step ${currentStep} of ${progress.steps.length}: ${progress.steps[progress.stepIndex]}`}>
        <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${(currentStep / progress.steps.length) * 100}%` }} />
      </div>
      <p className="text-sm font-medium text-foreground">Step {currentStep} of {progress.steps.length}: {progress.steps[progress.stepIndex]}</p>
      <ol className="space-y-2 text-sm">
        {progress.steps.map((step, index) => <li key={step} className={`flex items-center gap-2 ${index <= progress.stepIndex ? "text-foreground" : "text-foreground-muted"}`}><span className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-xs ${index < progress.stepIndex ? "border-primary bg-primary text-primary-foreground" : index === progress.stepIndex ? "border-primary text-primary" : "border-border"}`} aria-hidden="true">{index < progress.stepIndex ? "✓" : index + 1}</span>{step}</li>)}
      </ol>
      <p className="text-xs text-foreground-muted">{elapsedSeconds} {elapsedSeconds === 1 ? "second" : "seconds"} elapsed. Usually a few seconds; larger profiles can take longer.</p>
    </div>
  );
}

function PasswordField({ inputRef, value, onChange, show, onShow, label, confirmation, autoComplete, disabled }: Readonly<{
  inputRef?: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onShow: (value: boolean) => void;
  label: string;
  confirmation: boolean;
  autoComplete: "new-password" | "current-password";
  disabled: boolean;
}>) {
  const id = confirmation ? "genie-backup-password-confirm" : "genie-backup-password";
  return <div><label htmlFor={id} className="block text-sm font-medium text-foreground">{label}</label><div className="mt-1 flex gap-2"><input ref={inputRef} id={id} type={show ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} autoComplete={autoComplete} className="w-full rounded-md border border-border bg-background-element px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60" /><button type="button" onClick={() => onShow(!show)} disabled={disabled} className="rounded-md border border-border px-2 text-xs text-foreground-muted hover:text-foreground disabled:opacity-50" aria-label={show ? "Hide backup password" : "Show backup password"}>{show ? "Hide" : "Show"}</button></div></div>;
}
