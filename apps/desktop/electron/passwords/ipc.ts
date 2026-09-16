/**
 * D403 (ISSUE-D403) Phase 0 — main-process IPC wiring for the embedded-browser
 * password layer.
 *
 * `registerPasswordsIpc` registers the human-only `passwords:*` handlers
 * (lookup + stageSave/commitSave/dismissSave + applyFill + the formDetected
 * forwarder) and delegates persistence to the injected `CredentialBackend`
 * (P2 = KDBX-backed). The plaintext password only ever flows guest→main
 * (stageSave) and main→guest (applyFill); it is NEVER returned to any invoker.
 *
 * ============================ SECURITY (R6) ============================
 * WEB CREDENTIALS ARE HUMAN-ONLY. These channels exist to serve the human
 * operating the embedded browser — the guest `<webview>` preload and the host
 * (mainWindow) renderer's save/autofill UX — and NOTHING ELSE.
 *
 * They must NEVER be exposed on any agent/tool/CDP surface, and web credentials
 * must NEVER enter agent/LLM context. Do NOT add these channels to any
 * agent-facing API, MCP tool, relay surface, or the agent-browser/CDP bridge.
 * The plaintext password never leaves the main process except as a single
 * `PasswordFillValue` released on an explicit user gesture (enforced in P3).
 *
 * Enforcement is defence-in-depth:
 *   1. The page's main world has no `ipcRenderer` (contextIsolation) — CDP /
 *      `Runtime.evaluate` on the guest page cannot reach these channels.
 *   2. `assertCredentialSender` (injected by main.ts) rejects any sender that
 *      is not the mainWindow renderer or an embedded-browser `<webview>` guest.
 * ======================================================================
 */

import { ipcMain, type WebContents } from "electron";

import { PasswordStagingMap } from "./staging";
import type {
  ApplyFillCommand,
  ApplyFillRequest,
  CommitSaveRequest,
  CredentialBackend,
  DetectedLoginForm,
  DismissSaveRequest,
  FormDetectedNotice,
  PasswordActionResult,
  PasswordLookupRequest,
  PendingSaveNotice,
  StageSaveRequest,
} from "./types";

/** Channel names, centralized so the guest/host/main all agree on the wire. */
const PASSWORDS_CHANNELS = {
  lookup: "passwords:lookup",
  stageSave: "passwords:stageSave",
  commitSave: "passwords:commitSave",
  dismissSave: "passwords:dismissSave",
  applyFill: "passwords:applyFill",
  /** guest→main (on) AND main→host (send): a form was detected. */
  formDetected: "passwords:formDetected",
  /** host→main (invoke): pull the last detected form for a guest — race-proof
   *  autofill on attach, when the one-shot `formDetected` push was missed. */
  getDetectedForm: "passwords:getDetectedForm",
  /** main→host (send): a credential is staged and awaits the human. */
  pendingSave: "passwords:pendingSave",
} as const;

// Staging map lives in the Electron-free `staging.ts` so it stays unit-testable
// (importing this module pulls in `electron`). Re-exported for existing consumers.
export { PasswordStagingMap };
export type { StagedCredential } from "./staging";

export interface RegisterPasswordsIpcOptions {
  /** Credential store. P0 = `NoopBackend`; P2 = KDBX-backed. */
  backend: CredentialBackend;
  /**
   * Throws unless the IPC sender is an allowed HUMAN surface (the mainWindow
   * renderer or an embedded-browser `<webview>` guest). Injected from main.ts
   * so this module stays decoupled from window/webContents state. Typed on the
   * common `{ sender }` shape so it gates both `invoke` (`IpcMainInvokeEvent`)
   * and fire-and-forget (`IpcMainEvent`, e.g. `formDetected`) channels.
   */
  assertCredentialSender: (event: { sender: WebContents }) => void;
  /**
   * The host (mainWindow) renderer's webContents, or null if unavailable.
   * Used to push `pendingSave` / `formDetected` notices to the save/autofill UX.
   * A getter (not a value) because the window is created/recreated over the
   * app lifetime and this module is registered once at startup.
   */
  getHostWebContents: () => WebContents | null;
  /**
   * Resolve a live guest webContents by id so main can deliver the one-shot
   * fill value directly to the guest. Returns null if the id is unknown/dead.
   * main.ts implements this via `webContents.fromId` and re-checks the type.
   */
  getGuestWebContents: (webContentsId: number) => WebContents | null;
  /** Optional shared staging map (injectable for tests). Defaults to a new one. */
  staging?: PasswordStagingMap;
}

/**
 * Register the human-only `passwords:*` IPC handlers. Call once, from main.ts,
 * after `app.whenReady`-adjacent setup. Idempotency is the caller's concern
 * (main.ts registers module-level handlers exactly once, like the other
 * `ipcMain.handle` channels).
 */
export function registerPasswordsIpc(opts: RegisterPasswordsIpcOptions): void {
  const {
    backend,
    assertCredentialSender,
    getHostWebContents,
    getGuestWebContents,
  } = opts;
  const staging = opts.staging ?? new PasswordStagingMap();
  // Last detected login form per guest webContents id. Cached so the host can
  // PULL it on attach — the one-shot `formDetected` push can fire before the
  // host listener is ready on a cold start (the page loads from cache and emits
  // before the panel subscribes), which would otherwise drop the autofill offer.
  const lastFormByGuest = new Map<number, DetectedLoginForm>();

  ipcMain.handle(
    PASSWORDS_CHANNELS.lookup,
    async (event, req: PasswordLookupRequest) => {
      assertCredentialSender(event);
      return backend.lookup(req);
    },
  );

  // guest → main: stage a submitted credential (has password). Kept in memory
  // only, keyed by ORIGIN so the offer survives the post-submit navigation; the
  // host is notified with metadata only. NEVER returns the password.
  ipcMain.handle(
    PASSWORDS_CHANNELS.stageSave,
    async (event, req: StageSaveRequest) => {
      assertCredentialSender(event);
      // Don't nag when nothing changed: an autofilled login re-submits the same
      // credential. Suppress the offer if it's identical; say "Update" (not
      // "Save") when the same user has a new password. (Chrome/Firefox parity.)
      const match = await backend.matchCredential({
        origin: req.origin,
        username: req.username,
        password: req.password,
      });
      if (match === "identical") return;
      staging.stage({
        origin: req.origin,
        username: req.username,
        password: req.password,
      });
      const notice: PendingSaveNotice = {
        origin: req.origin,
        username: req.username,
        kind: match === "password-differs" ? "update" : "new",
      };
      const host = getHostWebContents();
      host?.send(PASSWORDS_CHANNELS.pendingSave, notice);
    },
  );

  // host → main: persist a staged credential (addressed by origin). The
  // plaintext is resolved from the staging map here in main; it never crossed
  // the renderer. Returns only a boolean.
  ipcMain.handle(
    PASSWORDS_CHANNELS.commitSave,
    async (event, req: CommitSaveRequest): Promise<PasswordActionResult> => {
      assertCredentialSender(event);
      const cred = staging.take(req.origin);
      if (!cred) return { ok: false };
      await backend.save({
        origin: cred.origin,
        username: cred.username,
        password: cred.password,
      });
      return { ok: true };
    },
  );

  // host → main: discard a staged credential without persisting.
  ipcMain.handle(
    PASSWORDS_CHANNELS.dismissSave,
    (event, req: DismissSaveRequest): PasswordActionResult => {
      assertCredentialSender(event);
      return { ok: staging.clear(req.origin) };
    },
  );

  // host → main → guest: resolve the secret in main and deliver it straight to
  // the guest webContents. The secret is NEVER returned to the host invoker.
  ipcMain.handle(
    PASSWORDS_CHANNELS.applyFill,
    async (event, req: ApplyFillRequest): Promise<PasswordActionResult> => {
      assertCredentialSender(event);
      const guest = getGuestWebContents(req.webContentsId);
      if (!guest) return { ok: false };
      const value = await backend.getFillValue({ id: req.id });
      if (!value) return { ok: false };
      const command: ApplyFillCommand = {
        username: value.username,
        password: value.password,
      };
      guest.send(PASSWORDS_CHANNELS.applyFill, command);
      return { ok: true };
    },
  );

  // guest → main → host: forward a detected login form to the host so it can
  // offer autofill. Fire-and-forget (`ipcMain.on`), so we gate the sender with
  // the same predicate but swallow rejections (no invoke channel to reject on).
  ipcMain.on(
    PASSWORDS_CHANNELS.formDetected,
    (event, form: DetectedLoginForm) => {
      try {
        assertCredentialSender(event);
      } catch {
        return;
      }
      // Cache for the host pull (below); prune entries whose guest is gone.
      lastFormByGuest.set(event.sender.id, form);
      for (const id of [...lastFormByGuest.keys()]) {
        if (!getGuestWebContents(id)) lastFormByGuest.delete(id);
      }
      const notice: FormDetectedNotice = {
        webContentsId: event.sender.id,
        form,
      };
      const host = getHostWebContents();
      host?.send(PASSWORDS_CHANNELS.formDetected, notice);
    },
  );

  // host → main: pull the last detected form for a guest (race-proof autofill on
  // attach). Returns null if none cached or the guest is gone. No secret.
  ipcMain.handle(
    PASSWORDS_CHANNELS.getDetectedForm,
    (event, req: { webContentsId: number }): DetectedLoginForm | null => {
      assertCredentialSender(event);
      if (!getGuestWebContents(req.webContentsId)) {
        lastFormByGuest.delete(req.webContentsId);
        return null;
      }
      return lastFormByGuest.get(req.webContentsId) ?? null;
    },
  );
}
