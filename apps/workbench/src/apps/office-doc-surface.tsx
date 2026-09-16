import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Focus,
  Highlighter,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Loader2,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Redo2,
  RemoveFormatting,
  Save,
  Square,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { apiClient } from "../lib/api";
import {
  type CoolMessage,
  toolbarButtonClass,
  toolbarSelectClass,
  RibbonGroup,
  RibbonTabStrip,
  PARAGRAPH_STYLES,
  FONT_FAMILIES,
  FONT_SIZES,
  stateStr,
  intColorToHex,
  ColorSwatchMenu,
  InsertTableMenu,
  InsertLinkMenu,
  FindReplaceMenu,
  injectChromeStrip,
  iframeHasDocumentCanvas,
  collaboraMapFromWindow,
  isUnoActive,
  reduceCommandState,
  subscribeCommandState,
  subscribeCellState,
  subscribePartState,
  subscribeSlidePreviews,
  subscribeBackgroundSave,
  subscribePresentationState,
  dispatchOfficeAction,
  endOfficePresentation,
  triggerLocalImageInsert,
  fitEditorWidth,
  focusIsInExternalTextEntry,
  focusEditorFrame,
} from "./office-ribbon";
import type { RibbonActions, RibbonTabDef, PartStateSnapshot } from "./office-ribbon";
import { CalcNumberGroup, CalcCellsGroup, CalcDataGroup } from "./office-calc-groups";
import { ImpressSlideGroup, ImpressInsertGroup, ImpressPresentGroup } from "./office-impress-groups";
import { CalcSheetTabs } from "./office-calc-sheettabs";
import { ImpressSlideRail } from "./office-impress-slide-rail";
import { WriterReviewGroup } from "./office-writer-review-group";
import { clearActiveMiniApp, publishActiveMiniApp } from "../adapters/mini-app-context-ref";

/**
 * D362 Tier 2 — office editor surface (Writer/Calc/Impress) backed by the
 * Collabora `coolwsd` engine.
 *
 * IMPORTANT (D362 spike finding, 2026-07-02): Collabora only enables its
 * postMessage integration API (hide chrome, `Send_UNO_Command`, status events)
 * when it detects it is embedded in an IFRAME (`window.parent !== window`).
 * Inside an Electron `<webview>` the guest is top-level, so integration is
 * silently OFF — which is why an earlier `<webview>` build could never hide the
 * menubar. Hence this surface embeds Collabora in a cross-origin `<iframe>` and
 * speaks the real parent↔frame postMessage protocol. The document is rendered
 * by the engine (canvas tiles); we hide Collabora's own chrome and drive it
 * from our own Lucide toolbar so users see a single icon language
 * (specs/libreoffice-office-ui.md §5).
 */
export interface OfficeDocSurfaceProps {
  artifactId: string;
  displayName: string;
  documentPath: string;
  roomId?: string;
  onClose: () => void;
  onFocus?: () => void;
  onToggleChat?: () => void;
  chatVisible?: boolean;
  assistantName?: string;
}

/**
 * Save indicator states. Collabora has no "save started" event, so `saving`
 * is only shown for an explicit user Save (`Action_Save`); AutoSave fires
 * neither `Action_Save_Resp` nor `Doc_ModifiedStatus: false`, so the surface
 * additionally subscribes to coolwsd's `statusindicator` background-save
 * events (see `subscribeBackgroundSave`) — `start` shows `saving`, `finish`
 * clears `unsaved`/`saving` after a background PutFile. The header renders a
 * PERSISTENT pill: `saved` flashes then settles to `idle`, and BOTH `idle` and
 * `saved` display a steady "Saved" (the pill never blanks out).
 */
type OfficeSaveState = "idle" | "unsaved" | "saving" | "saved";

/** Last path segment of a logical workspace path. */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

export function OfficeDocSurface({
  artifactId,
  displayName,
  documentPath,
  roomId,
  onClose,
  onFocus,
  onToggleChat,
  chatVisible,
  assistantName = "Genie",
}: OfficeDocSurfaceProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Pane width (px) at the last fit-to-width, so we only re-fit when the
  // width actually changed (avoids scroll-jitter on a settled doc).
  const lastFitWidthRef = useRef(0);
  // Once the user manually zooms (toolbar buttons), stop auto-fitting so we
  // don't fight their chosen zoom on the next resize.
  const userZoomedRef = useRef(false);
  const [editorUrl, setEditorUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [visualReady, setVisualReady] = useState(false);
  const [saveState, setSaveState] = useState<OfficeSaveState>("idle");
  // §3.3.6 — live command state from the editor (Bold on/off, current
  // paragraph style / font / size, list + alignment). Bare command keys.
  const [cmdState, setCmdState] = useState<Record<string, unknown>>({});
  // Wave C — which office app this surface is editing, from the file extension.
  // Drives the app-aware ribbon (Writer = no-tab bands; Calc/Impress = tabs).
  const appType = useMemo<"writer" | "calc" | "impress">(() => {
    const ext = displayName.toLowerCase().split(".").pop() ?? "";
    if (["xlsx", "xlsm", "xls", "ods", "csv"].includes(ext)) return "calc";
    if (["pptx", "ppt", "odp"].includes(ext)) return "impress";
    return "writer";
  }, [displayName]);
  const [activeTab, setActiveTab] = useState("home");
  // Wave C (Calc) — active cell address + formula for the formula bar, pushed
  // by the engine via `celladdress`/`cellformula` map events. Drafts mirror the
  // engine value and reset when the caret moves to a new cell.
  const [cellAddress, setCellAddress] = useState("");
  const [cellFormula, setCellFormula] = useState("");
  const [refDraft, setRefDraft] = useState("");
  const [formulaDraft, setFormulaDraft] = useState("");
  // Wave C — document part list (Calc sheets / Impress slides), pushed by the
  // engine via the `updateparts` map event (see subscribePartState).
  const [parts, setParts] = useState<PartStateSnapshot>({ count: 0, selectedPart: 0, names: [] });
  // Wave C (Impress) — live slide thumbnails keyed by 0-based part index, fed by
  // Collabora's getPreview → `tilepreview` feed (see subscribeSlidePreviews).
  // Lets our rail show real previews so we can suppress Collabora's own
  // #navigation-sidebar and keep a single on-brand navigator.
  const [slidePreviews, setSlidePreviews] = useState<Record<number, string>>({});
  // D362 §5b — true while the canvas slideshow is running inside the editor
  // iframe. Gates the parent-side "Exit presentation" button (visible while
  // presenting, when the ribbon is hidden by browser-fullscreen). Subscribed
  // via `subscribePresentationState` (presentationinfo / endpresentation /
  // fullscreenchange on the iframe document).
  const [presenting, setPresenting] = useState(false);
  useEffect(() => setRefDraft(cellAddress), [cellAddress]);
  useEffect(() => setFormulaDraft(cellFormula), [cellFormula]);
  const publishOfficeContext = useCallback(() => {
    const appName = appType === "writer" ? "Writer" : appType === "calc" ? "Calc" : "Impress";
    publishActiveMiniApp({
      appId: `office-${appType}`,
      appName,
      documentPath,
      targetKind: "artifact",
      summary: { kind: "office-doc", officeKind: appType },
      updatedAt: Date.now(),
    });
  }, [appType, documentPath]);
  useEffect(() => {
    publishOfficeContext();
    return () => clearActiveMiniApp();
  }, [publishOfficeContext]);
  const savedFlashTimer = useRef<number | null>(null);
  // Watchdog: a manual Save with DontSaveIfUnmodified emits NO Action_Save_Resp
  // when the doc is already clean, which would otherwise leave "Saving…" stuck
  // forever. Clear the indicator if no save event resolves it in time.
  const saveWatchdog = useRef<number | null>(null);
  // D362 audit C2 — ref mirror of `saveState` so the coolwsd `statusindicator`
  // background-save subscription can read the CURRENT state without a stale
  // closure (the subscription attaches once on `editorUrl` change, not on every
  // state flip). Used to gate `flashSaved()` on `=== "unsaved"` so a background
  // PutFile that fires when the doc is already idle doesn't briefly flash
  // "Saved" (mirrors Collabora's own `SaveState.showSavedStatus` gating on
  // `!classList.contains('savemodified')`).
  const saveStateRef = useRef<OfficeSaveState>("idle");
  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);
  // Flash "Saved" then fade to idle. Used for both autosave (doc flips
  // unmodified) and explicit-save completion.
  const flashSaved = useCallback(() => {
    setSaveState("saved");
    if (savedFlashTimer.current !== null) window.clearTimeout(savedFlashTimer.current);
    savedFlashTimer.current = window.setTimeout(() => {
      setSaveState((s) => (s === "saved" ? "idle" : s));
    }, 2500);
  }, []);

  // Local copy of the display name so an in-title rename reflects immediately
  // without waiting for the parent to re-open the surface. Rename is INLINE
  // (no modal) — `editingName` swaps the title for an input; `isRenamingRef`
  // gates the post-load focus-retry loop so Collabora can't steal focus (and
  // keystrokes) out of the rename input mid-load.
  const [name, setName] = useState(displayName);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameDirRef = useRef<string>("");
  const isRenamingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => setName(displayName), [displayName]);
  useEffect(() => {
    if (editingName) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [editingName]);

  const collaboraOrigin = useMemo(() => {
    if (editorUrl === null) return null;
    try {
      return new URL(editorUrl).origin;
    } catch {
      return null;
    }
  }, [editorUrl]);

  // Resolve the server-assembled editor URL (mints a WOPI token). We request
  // edit permission; the server still gates actual writability via the token's
  // namespace grant (CheckFileInfo `UserCanWrite`).
  useEffect(() => {
    let cancelled = false;
    setEditorUrl(null);
    setError(null);
    setReady(false);
    setVisualReady(false);
    setSaveState("idle");
    setCmdState({});
    lastFitWidthRef.current = 0;
    userZoomedRef.current = false;
    void (async () => {
      try {
        const { editorUrl: url } = await apiClient.getOfficeEditorUrl(artifactId, {
          permission: "edit",
          ...(roomId !== undefined ? { roomId } : {}),
        });
        if (cancelled) return;
        if (url === null || url.length === 0) {
          setError("The office engine is unavailable. Try again in a moment.");
          return;
        }
        setEditorUrl(url);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to open the document.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId, roomId]);

  const postToEditor = useCallback(
    (msg: CoolMessage) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || collaboraOrigin === null) return;
      win.postMessage(JSON.stringify(msg), collaboraOrigin);
    },
    [collaboraOrigin],
  );

  // Fit the doc to the pane width, but only when it's worth doing: the canvas
  // is ready, the user hasn't taken manual zoom control, and the pane width
  // actually changed since the last fit. Used both across the load window and
  // on pane resizes (chat panel toggle, window resize) — the exact cases that
  // otherwise leave the page too big (half off-screen) or too small.
  const maybeFitWidth = useCallback((force = false) => {
    const iframe = iframeRef.current;
    if (!iframe || userZoomedRef.current) return;
    if (!iframeHasDocumentCanvas(iframe)) return;
    const width = Math.round(iframe.getBoundingClientRect().width);
    if (width <= 0) return;
    if (!force && Math.abs(width - lastFitWidthRef.current) <= 1) return;
    fitEditorWidth(iframe);
    lastFitWidthRef.current = width;
  }, []);

  // Parent↔frame protocol. Collabora posts status events (App_LoadingStatus,
  // Doc_ModifiedStatus, …). After Document_Loaded we complete the
  // `Host_PostmessageReady` handshake, then hide Collabora's chrome so only our
  // toolbar shows. (The CODE welcome splash is disabled engine-side via
  // `--o:welcome.enable=false`.)
  useEffect(() => {
    if (collaboraOrigin === null) return;
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== collaboraOrigin) return;
      let msg: CoolMessage;
      try {
        msg = typeof ev.data === "string" ? (JSON.parse(ev.data) as CoolMessage) : (ev.data as CoolMessage);
      } catch {
        return;
      }
      if (msg.MessageId === "App_LoadingStatus" && msg.Values?.["Status"] === "Document_Loaded") {
        postToEditor({ MessageId: "Host_PostmessageReady" });
        // Strip Collabora's chrome — our React toolbar owns the affordances.
        // Order matters + a small stagger: switch off the notebookbar ribbon
        // (classic mode) first, then hide the menubar/sidebar/ruler that classic
        // mode reveals. Verified live (D362 spike 2026-07-02): classic + hide
        // removes the ribbon; Hide_Sidebar removes the properties panel.
        postToEditor({ MessageId: "Action_ChangeUIMode", Values: { Mode: "classic" } });
        window.setTimeout(() => {
          postToEditor({ MessageId: "Hide_Menubar" });
          postToEditor({ MessageId: "Hide_Sidebar" });
          postToEditor({ MessageId: "Hide_Ruler" });
          postToEditor({ MessageId: "Hide_StatusBar" });
        }, 300);
        // §3.1b — once same-origin (proxied), CSS-strip the chrome postMessage
        // can't hide. Retried because Collabora renders its chrome async after
        // Document_Loaded (the welcome IFrameDialog in particular can register
        // seconds later and re-wedge the cursor — hence the late retries).
        // No-ops safely while still cross-origin.
        [0, 400, 1000, 2000, 4000, 8000].forEach((d) =>
          window.setTimeout(() => {
            injectChromeStrip(iframeRef.current);
            if (iframeHasDocumentCanvas(iframeRef.current)) {
              setVisualReady(true);
              // Fix Collabora's bad initial fit (renders the page tiny, or —
              // if we'd forced 100% — too wide to fit) by driving its own
              // fit-page-width against the now-settled pane width.
              maybeFitWidth();
              // Auto-focus the editor so the caret is live — but ONLY when the
              // user isn't busy elsewhere. Skip while renaming in the title bar
              // (dropped keystrokes into the doc) OR while focus sits in the
              // chat composer / any external text field (the doc was yanking
              // focus mid-prompt). If they're not typing elsewhere, focusing
              // the freshly-opened doc is the desired behavior.
              if (!isRenamingRef.current && !focusIsInExternalTextEntry(iframeRef.current)) {
                focusEditorFrame(iframeRef.current);
              }
            }
          }, d),
        );
        setReady(true);
      } else if (msg.MessageId === "Doc_ModifiedStatus") {
        if (msg.Values?.["Modified"] === true) setSaveState("unsaved");
        else flashSaved();
      } else if (msg.MessageId === "Action_Save_Resp") {
        if (msg.Values?.["success"] === false) setSaveState("unsaved");
        else flashSaved();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [collaboraOrigin, postToEditor, flashSaved, maybeFitWidth]);

  // Re-fit to width when the pane resizes — hiding/showing the chat panel or
  // resizing the window changes the available width, which otherwise leaves
  // the page too wide (half off-screen) or too small. Debounced; skipped once
  // the user has taken manual zoom control (see maybeFitWidth).
  useEffect(() => {
    if (editorUrl === null) return;
    const el = iframeRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => maybeFitWidth(), 150);
    });
    ro.observe(el);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [editorUrl, maybeFitWidth]);

  // §3.3.6 — subscribe to the editor's live command state so our toolbar
  // reflects it (Bold lit when the caret is in bold text, etc.). The map
  // may not be ready the instant the doc loads, so retry briefly until the
  // subscription attaches; clean up on unmount / doc change.
  useEffect(() => {
    if (editorUrl === null) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const timers = [0, 300, 800, 1500, 3000, 6000].map((d) =>
      window.setTimeout(() => {
        if (cancelled || unsub) return;
        unsub = subscribeCommandState(iframeRef.current, (commandName, state) => {
          setCmdState((prev) => reduceCommandState(prev, commandName, state));
        });
      }, d),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      if (unsub) unsub();
    };
  }, [editorUrl]);

  // Wave C (Calc) — subscribe to active-cell address/formula for the formula
  // bar. Same retry-until-attached pattern as the command-state subscription.
  useEffect(() => {
    if (editorUrl === null || appType !== "calc") return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const timers = [0, 300, 800, 1500, 3000, 6000].map((d) =>
      window.setTimeout(() => {
        if (cancelled || unsub) return;
        unsub = subscribeCellState(iframeRef.current, setCellAddress, setCellFormula);
      }, d),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      if (unsub) unsub();
    };
  }, [editorUrl, appType]);

  // Wave C — subscribe to the document part list (Calc sheets / Impress slides)
  // so the sheet-tab bar / slide rail reflect count + active + names. Same
  // retry-until-attached ladder as the cell-state subscription.
  useEffect(() => {
    if (editorUrl === null || (appType !== "calc" && appType !== "impress")) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const timers = [0, 300, 800, 1500, 3000, 6000].map((d) =>
      window.setTimeout(() => {
        if (cancelled || unsub) return;
        unsub = subscribePartState(iframeRef.current, setParts);
      }, d),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      if (unsub) unsub();
    };
  }, [editorUrl, appType]);

  // Wave C (Impress) — subscribe to live slide previews so the rail shows real
  // thumbnails (getPreview → `tilepreview`, autoUpdate keeps them live). Same
  // retry ladder; Impress-only (getPreview is a no-op for text, and Calc uses
  // the sheet-tab bar, not thumbnails).
  useEffect(() => {
    if (editorUrl === null || appType !== "impress") return;
    setSlidePreviews({});
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const onPreview = (index: number, src: string): void =>
      setSlidePreviews((prev) => (prev[index] === src ? prev : { ...prev, [index]: src }));
    const timers = [0, 300, 800, 1500, 3000, 6000].map((d) =>
      window.setTimeout(() => {
        if (cancelled || unsub) return;
        unsub = subscribeSlidePreviews(iframeRef.current, onPreview);
      }, d),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      if (unsub) unsub();
    };
  }, [editorUrl, appType]);

  // D362 audit C2 — subscribe to coolwsd's background-save completion signal so
  // the "unsaved" indicator clears after an AutoSave. The postMessage handler
  // above already clears on `Action_Save_Resp` (explicit Save) and
  // `Doc_ModifiedStatus: false` (only emitted after explicit Save); AutoSave
  // fires neither, so without this subscription the chrome reads "Unsaved"
  // indefinitely after a background PutFile. Grounded in
  // `EXTERNAL/collabora-online-source/browser/src/app/Socket.ts:2376-2399` +
  // `browser/src/map/Map.js:1472-1493` — see `subscribeBackgroundSave` in
  // `office-ribbon.tsx`. Same retry-until-attached ladder as the other
  // subscriptions; gated on `saveState` so a background tick that fires while
  // idle doesn't flash a misleading "Saving…"/"Saved" — a background `start`
  // shows "Saving…" only when unsaved, and `finish` settles to "Saved" only
  // when a write was pending (unsaved) or in flight (saving).
  useEffect(() => {
    if (editorUrl === null) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const timers = [0, 300, 800, 1500, 3000, 6000].map((d) =>
      window.setTimeout(() => {
        if (cancelled || unsub) return;
        unsub = subscribeBackgroundSave(
          iframeRef.current,
          () => {
            // Background PutFile finished. Settle to a persistent "Saved" only
            // when a write was actually pending (unsaved) or in flight (saving)
            // — a background tick that fires while already idle must not flash
            // a misleading "Saved" (D362 audit C2).
            if (saveStateRef.current === "unsaved" || saveStateRef.current === "saving") flashSaved();
          },
          () => {
            // Background save started. Show "Saving…" only when changes are
            // pending; a tick while idle stays a persistent "Saved".
            if (saveStateRef.current === "unsaved") setSaveState("saving");
          },
        );
      }, d),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      if (unsub) unsub();
    };
  }, [editorUrl, flashSaved]);

  // D362 §5b — subscribe to the canvas slideshow's running state so the
  // parent-side "Exit presentation" button shows ONLY while presenting. The
  // signal events are `presentationinfo` (start) and `endpresentation` /
  // iframe-document `fullscreenchange` (exit); seeded by a direct
  // `_checkAlreadyPresenting()` query. Same retry-until-attached ladder as
  // the other subscriptions; Impress-only (Writer/Calc have no slideshow).
  useEffect(() => {
    if (editorUrl === null || appType !== "impress") return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const timers = [0, 300, 800, 1500, 3000, 6000].map((d) =>
      window.setTimeout(() => {
        if (cancelled || unsub) return;
        unsub = subscribePresentationState(iframeRef.current, setPresenting);
      }, d),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      if (unsub) unsub();
    };
  }, [editorUrl, appType]);

  const sendUno = useCallback(
    (command: string) => {
      postToEditor({ MessageId: "Send_UNO_Command", Values: { Command: command } });
      window.setTimeout(() => focusEditorFrame(iframeRef.current), 0);
    },
    [postToEditor],
  );

  // §3.3.5-B — UNO command WITH args, via the integrator Send_UNO_Command
  // (Map.WOPI.js passes `Values.Args` straight to `sendUnoCommand`). Arg
  // shapes grounded in Collabora's own toolbar (Toolbar.js applyFont/
  // applyFontSize, Control.TopToolbar applyStyle): CharFontName.FamilyName,
  // FontHeight.Height (float-as-string), StyleApply Style+FamilyName.
  const sendUnoArgs = useCallback(
    (command: string, args: Record<string, { type: string; value: unknown }>) => {
      postToEditor({ MessageId: "Send_UNO_Command", Values: { Command: command, Args: args } });
      window.setTimeout(() => focusEditorFrame(iframeRef.current), 0);
    },
    [postToEditor],
  );

  // Save uses the integrator postMessage API (`Action_Save`), which routes
  // through Collabora's WOPI handler → our `/wopi/*` PutFile. Sending
  // `.uno:Save` over Send_UNO_Command does not reliably drive that host path.
  const saveDocument = useCallback(() => {
    setSaveState("saving");
    postToEditor({
      MessageId: "Action_Save",
      Values: { DontTerminateEdit: true, DontSaveIfUnmodified: true },
    });
    // If nothing was modified, coolwsd sends no Action_Save_Resp — don't let
    // "Saving…" hang. Fall back to idle after a grace window if unresolved.
    if (saveWatchdog.current !== null) window.clearTimeout(saveWatchdog.current);
    saveWatchdog.current = window.setTimeout(() => {
      setSaveState((s) => (s === "saving" ? "idle" : s));
    }, 5000);
    window.setTimeout(() => focusEditorFrame(iframeRef.current), 0);
  }, [postToEditor]);

  // Zoom is client-side in Collabora Online — call the map directly rather than
  // sending a UNO command (which the tile view ignores).
  const zoomBy = useCallback((direction: "in" | "out") => {
    // User is taking manual zoom control — stop auto-fitting on resize so we
    // don't stomp their chosen zoom level.
    userZoomedRef.current = true;
    const map = collaboraMapFromWindow(iframeRef.current?.contentWindow);
    if (direction === "in") map?.zoomIn?.(1);
    else map?.zoomOut?.(1);
    window.setTimeout(() => focusEditorFrame(iframeRef.current), 0);
  }, []);

  // Wave C — switch the active part (Calc sheet / Impress slide). This is a
  // CLIENT operation (`map.setPart(n)`, browser/src/control/Parts.js), not a UNO
  // command — same rationale as zoom above.
  const switchPart = useCallback((index: number) => {
    const map = collaboraMapFromWindow(iframeRef.current?.contentWindow);
    map?.setPart?.(index);
    window.setTimeout(() => focusEditorFrame(iframeRef.current), 0);
  }, []);

  // D362 §5a — dispatch a Collabora browser-side action id (e.g.
  // `fullscreen-presentation`) into the same-origin editor iframe. This is the
  // path Collabora's own menubar uses (`Control.Menubar.ts:2337`), which
  // `docdispatcher.ts:511-537` maps to `app.map.fire('newfullscreen')` →
  // `SlideShowPresenter._onStart` → the canvas slideshow. Replaces sending
  // `.uno:Presentation` (a LibreOffice *core* slot that ran the un-exitable
  // in-core `ShowWindow` slideshow). Returns true if dispatched.
  const dispatchClientAction = useCallback((action: string): boolean => {
    const ok = dispatchOfficeAction(iframeRef.current, action);
    window.setTimeout(() => focusEditorFrame(iframeRef.current), 0);
    return ok;
  }, []);

  // D362 §5b — end the running canvas slideshow. Calls the canvas path
  // (`map.slideShowPresenter.endPresentation(true)` — the SAME method
  // Collabora's `#endshow` End Show button + Escape keydown funnel into,
  // `SlideShowPresenter.ts:802-822`) AND sends `.uno:PresentationEnd` as a
  // belt-and-braces core-path kill switch (`drviewse.cxx:840-846` →
  // `StopSlideShow()` → `xPresentation->end()`; no-op if the core slideshow
  // isn't running). Used by the parent-side "Exit presentation" button.
  const exitPresentation = useCallback(() => {
    endOfficePresentation(iframeRef.current);
    postToEditor({ MessageId: "Send_UNO_Command", Values: { Command: ".uno:PresentationEnd" } });
    // Optimistically flip the gate off so the button disappears immediately;
    // the subscription's `endpresentation` / `fullscreenchange` signals will
    // confirm (or correct) shortly.
    setPresenting(false);
    window.setTimeout(() => focusEditorFrame(iframeRef.current), 0);
  }, [postToEditor]);

  // Inline rename. Resolve the artifact's FULL logical path first (the surface
  // only knows the basename) so we edit just the last segment and preserve the
  // containing folder. `isRenamingRef` is set synchronously so the focus-retry
  // loop and the input's own blur handler see a consistent value.
  const startRename = useCallback(async () => {
    setRenameError(null);
    let full = name;
    try {
      const dto = await apiClient.getWorkspaceArtifact(artifactId, roomId !== undefined ? { roomId } : {});
      if (dto?.path) full = dto.path;
    } catch {
      // fall back to the basename we already have
    }
    const b = basename(full);
    renameDirRef.current = full.length > b.length ? full.slice(0, full.length - b.length - 1) : "";
    setDraftName(b);
    isRenamingRef.current = true;
    setEditingName(true);
  }, [artifactId, roomId, name]);

  const cancelRename = useCallback(() => {
    isRenamingRef.current = false;
    setEditingName(false);
    setRenameError(null);
    window.setTimeout(() => focusEditorFrame(iframeRef.current), 0);
  }, []);

  const commitRename = useCallback(async () => {
    const typed = draftName.trim();
    if (typed.length === 0) {
      setRenameError("Name cannot be empty");
      return;
    }
    if (typed.includes("/") || typed.includes("\\")) {
      setRenameError("Name cannot contain slashes");
      return;
    }
    // Preserve the office extension: a doc renamed without one (e.g. "Budget"
    // instead of "Budget.xlsx") loses its type and can no longer be opened in
    // the office editor. If the typed name has no extension, carry over the
    // current file's extension.
    const currentBase = basename(name);
    const dot = currentBase.lastIndexOf(".");
    const currentExt = dot > 0 ? currentBase.slice(dot) : "";
    const next = /\.[A-Za-z0-9]+$/.test(typed) ? typed : typed + currentExt;
    if (next === currentBase) {
      cancelRename();
      return;
    }
    const dir = renameDirRef.current;
    const newPath = dir.length > 0 ? `${dir}/${next}` : next;
    try {
      const updated = await apiClient.renameWorkspaceArtifact(
        artifactId,
        newPath,
        roomId !== undefined ? { roomId } : {},
      );
      setName(basename(updated.path));
      isRenamingRef.current = false;
      setEditingName(false);
      setRenameError(null);
      window.setTimeout(() => focusEditorFrame(iframeRef.current), 0);
    } catch (e) {
      // Keep the input open so the user can fix the name (e.g. a 409 collision).
      setRenameError(e instanceof Error ? e.message : "Rename failed");
    }
  }, [draftName, name, artifactId, roomId, cancelRename]);

  // §3.3.6 — is a tracked toggle command currently active at the caret?
  const on = (cmd: string): boolean => isUnoActive(cmdState[cmd]);

  // §3.3.5-B — current style/font/size from the state channel, with the
  // live value injected into the option list if it isn't a preset (so the
  // dropdown always shows what's actually at the caret). A leading blank
  // option keeps the controlled <select> valid before state seeds.
  const curStyle = stateStr(cmdState["StyleApply"]);
  const curFont = stateStr(cmdState["CharFontName"]);
  const curSize = stateStr(cmdState["FontHeight"]);
  const styleOptions =
    curStyle && !PARAGRAPH_STYLES.some((o) => o.style === curStyle)
      ? [...PARAGRAPH_STYLES, { label: curStyle, style: curStyle }]
      : PARAGRAPH_STYLES;
  const fontOptions =
    curFont && !FONT_FAMILIES.includes(curFont) ? [curFont, ...FONT_FAMILIES] : FONT_FAMILIES;
  const sizeOptions =
    curSize && !FONT_SIZES.includes(curSize) ? [...FONT_SIZES, curSize] : FONT_SIZES;

  // §3.3.5-C — current text/highlight color (as #rrggbb) for the swatch indicator.
  const fontColorHex = intColorToHex(cmdState["FontColor"]);
  const highlightHex = intColorToHex(cmdState["CharBackColor"]);

  // Persistent save pill: ALWAYS shows a state so the user can always tell
  // whether the doc is saved. `idle` (no pending changes) and `saved` (just
  // completed) both settle to a steady "Saved" — the pill never blanks out.
  const saveStatusLabel =
    saveState === "unsaved" ? "Unsaved" : saveState === "saving" ? "Saving…" : "Saved";

  // Wave C — the action surface the app-specific ribbon groups (Calc/Impress)
  // plug into (§3.3.6 state via isActive/stateValue).
  const actions: RibbonActions = {
    ready,
    sendUno,
    sendUnoArgs,
    isActive: (bare) => isUnoActive(cmdState[bare]),
    stateValue: (bare) => stateStr(cmdState[bare]),
    dispatchClientAction,
    exitPresentation,
    presenting,
  };

  // Wave C — Calc sheets / Impress slides derived from the part-state channel.
  // Names come from Core (Calc); fall back to a positional label when absent.
  const sheets = Array.from({ length: parts.count }, (_, i) => ({
    name: parts.names[i] ?? `Sheet ${i + 1}`,
    index: i,
  }));
  const slides = Array.from({ length: parts.count }, (_, i) => ({
    index: i,
    preview: slidePreviews[i],
  }));
  // Apply an AutoLayout to the CURRENT slide (WhatPage = active part). Grounded
  // in build-sheet §2 (`.uno:AssignLayout`, Toolbar.js:325-328).
  const applyLayout = (layoutId: number): void =>
    sendUnoArgs(".uno:AssignLayout", {
      WhatPage: { type: "unsigned short", value: parts.selectedPart },
      WhatLayout: { type: "unsigned short", value: layoutId },
    });

  // The reusable formatting groups (shared by all three apps). Hoisted from the
  // Writer toolbar verbatim so Writer renders identically; Calc/Impress compose
  // these with their own groups below.
  const actionsGroup = (
    <RibbonGroup label="Actions">
      <button type="button" title="Save" aria-label="Save" disabled={!ready} className={toolbarButtonClass()} onClick={saveDocument}>
        <Save aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Undo" aria-label="Undo" disabled={!ready} className={toolbarButtonClass()} onClick={() => sendUno(".uno:Undo")}>
        <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Redo" aria-label="Redo" disabled={!ready} className={toolbarButtonClass()} onClick={() => sendUno(".uno:Redo")}>
        <Redo2 aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </RibbonGroup>
  );
  const stylesGroup = (
    <RibbonGroup label="Styles">
      <select
        aria-label="Paragraph style"
        title="Paragraph style"
        disabled={!ready}
        className={`${toolbarSelectClass()} w-24`}
        value={curStyle}
        onChange={(e) =>
          sendUnoArgs(".uno:StyleApply", {
            Style: { type: "string", value: e.target.value },
            FamilyName: { type: "string", value: "ParagraphStyles" },
          })
        }
      >
        <option value="">Style</option>
        {styleOptions.map((o) => (
          <option key={o.style} value={o.style}>{o.label}</option>
        ))}
      </select>
    </RibbonGroup>
  );
  const fontGroup = (
    <RibbonGroup label="Font">
      <select
        aria-label="Font"
        title="Font"
        disabled={!ready}
        className={`${toolbarSelectClass()} w-28`}
        value={curFont}
        onChange={(e) =>
          sendUnoArgs(".uno:CharFontName", {
            "CharFontName.FamilyName": { type: "string", value: e.target.value },
          })
        }
      >
        <option value="">Font</option>
        {fontOptions.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
      <select
        aria-label="Font size"
        title="Font size"
        disabled={!ready}
        className={`${toolbarSelectClass()} w-14`}
        value={curSize}
        onChange={(e) =>
          sendUnoArgs(".uno:FontHeight", {
            "FontHeight.Height": { type: "float", value: e.target.value },
          })
        }
      >
        <option value="">Size</option>
        {sizeOptions.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <button type="button" title="Bold" aria-label="Bold" aria-pressed={on("Bold")} disabled={!ready} className={toolbarButtonClass(on("Bold"))} onClick={() => sendUno(".uno:Bold")}>
        <Bold aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Italic" aria-label="Italic" aria-pressed={on("Italic")} disabled={!ready} className={toolbarButtonClass(on("Italic"))} onClick={() => sendUno(".uno:Italic")}>
        <Italic aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Underline" aria-label="Underline" aria-pressed={on("Underline")} disabled={!ready} className={toolbarButtonClass(on("Underline"))} onClick={() => sendUno(".uno:Underline")}>
        <Underline aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Strikethrough" aria-label="Strikethrough" aria-pressed={on("Strikeout")} disabled={!ready} className={toolbarButtonClass(on("Strikeout"))} onClick={() => sendUno(".uno:Strikeout")}>
        <Strikethrough aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Subscript" aria-label="Subscript" aria-pressed={on("SubScript")} disabled={!ready} className={toolbarButtonClass(on("SubScript"))} onClick={() => sendUno(".uno:SubScript")}>
        <Subscript aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Superscript" aria-label="Superscript" aria-pressed={on("SuperScript")} disabled={!ready} className={toolbarButtonClass(on("SuperScript"))} onClick={() => sendUno(".uno:SuperScript")}>
        <Superscript aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Clear formatting" aria-label="Clear formatting" disabled={!ready} className={toolbarButtonClass()} onClick={() => sendUno(".uno:ResetAttributes")}>
        <RemoveFormatting aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <ColorSwatchMenu
        title="Text color"
        Icon={Baseline}
        autoLabel="Automatic"
        disabled={!ready}
        currentColor={fontColorHex}
        onPick={(value) => sendUnoArgs(".uno:FontColor", { "FontColor.Color": { type: "long", value } })}
      />
      <ColorSwatchMenu
        title="Highlight color"
        Icon={Highlighter}
        autoLabel="No fill"
        disabled={!ready}
        currentColor={highlightHex}
        onPick={(value) => sendUnoArgs(".uno:CharBackColor", { "CharBackColor.Color": { type: "long", value } })}
      />
    </RibbonGroup>
  );
  const paragraphGroup = (
    <RibbonGroup label="Paragraph">
      <button type="button" title="Bulleted list" aria-label="Bulleted list" aria-pressed={on("DefaultBullet")} disabled={!ready} className={toolbarButtonClass(on("DefaultBullet"))} onClick={() => sendUno(".uno:DefaultBullet")}>
        <List aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Numbered list" aria-label="Numbered list" aria-pressed={on("DefaultNumbering")} disabled={!ready} className={toolbarButtonClass(on("DefaultNumbering"))} onClick={() => sendUno(".uno:DefaultNumbering")}>
        <ListOrdered aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Align left" aria-label="Align left" aria-pressed={on("LeftPara")} disabled={!ready} className={toolbarButtonClass(on("LeftPara"))} onClick={() => sendUno(".uno:LeftPara")}>
        <AlignLeft aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Align center" aria-label="Align center" aria-pressed={on("CenterPara")} disabled={!ready} className={toolbarButtonClass(on("CenterPara"))} onClick={() => sendUno(".uno:CenterPara")}>
        <AlignCenter aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Align right" aria-label="Align right" aria-pressed={on("RightPara")} disabled={!ready} className={toolbarButtonClass(on("RightPara"))} onClick={() => sendUno(".uno:RightPara")}>
        <AlignRight aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Justify" aria-label="Justify" aria-pressed={on("JustifyPara")} disabled={!ready} className={toolbarButtonClass(on("JustifyPara"))} onClick={() => sendUno(".uno:JustifyPara")}>
        <AlignJustify aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Decrease indent" aria-label="Decrease indent" disabled={!ready} className={toolbarButtonClass()} onClick={() => sendUno(".uno:DecrementIndent")}>
        <IndentDecrease aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Increase indent" aria-label="Increase indent" disabled={!ready} className={toolbarButtonClass()} onClick={() => sendUno(".uno:IncrementIndent")}>
        <IndentIncrease aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </RibbonGroup>
  );
  // Alignment only (no lists/indent) — reused by Calc, where paragraph lists
  // and indent don't apply to cells.
  const alignGroup = (
    <RibbonGroup label="Align">
      <button type="button" title="Align left" aria-label="Align left" aria-pressed={on("LeftPara")} disabled={!ready} className={toolbarButtonClass(on("LeftPara"))} onClick={() => sendUno(".uno:LeftPara")}>
        <AlignLeft aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Align center" aria-label="Align center" aria-pressed={on("CenterPara")} disabled={!ready} className={toolbarButtonClass(on("CenterPara"))} onClick={() => sendUno(".uno:CenterPara")}>
        <AlignCenter aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Align right" aria-label="Align right" aria-pressed={on("RightPara")} disabled={!ready} className={toolbarButtonClass(on("RightPara"))} onClick={() => sendUno(".uno:RightPara")}>
        <AlignRight aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Justify" aria-label="Justify" aria-pressed={on("JustifyPara")} disabled={!ready} className={toolbarButtonClass(on("JustifyPara"))} onClick={() => sendUno(".uno:JustifyPara")}>
        <AlignJustify aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </RibbonGroup>
  );
  const writerInsertGroup = (
    <RibbonGroup label="Insert">
      <InsertTableMenu
        disabled={!ready}
        onInsert={(cols, rows) =>
          sendUnoArgs(".uno:InsertTable", {
            Columns: { type: "long", value: cols },
            Rows: { type: "long", value: rows },
          })
        }
      />
      <button type="button" title="Insert image" aria-label="Insert image" disabled={!ready} className={toolbarButtonClass()} onClick={() => triggerLocalImageInsert(iframeRef.current)}>
        <ImageIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <InsertLinkMenu
        disabled={!ready}
        onInsert={(text, url) =>
          sendUnoArgs(".uno:SetHyperlink", {
            "Hyperlink.Text": { type: "string", value: text },
            "Hyperlink.URL": { type: "string", value: url },
          })
        }
      />
      <button type="button" title="Insert comment" aria-label="Insert comment" disabled={!ready} className={toolbarButtonClass()} onClick={() => sendUno(".uno:InsertAnnotation")}>
        <MessageSquarePlus aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </RibbonGroup>
  );
  const editingGroup = (
    <RibbonGroup label="Editing">
      <FindReplaceMenu
        disabled={!ready}
        onSearch={(term, backward, replace, command) =>
          sendUnoArgs(".uno:ExecuteSearch", {
            "SearchItem.SearchString": { type: "string", value: term },
            "SearchItem.ReplaceString": { type: "string", value: replace },
            "SearchItem.Backward": { type: "boolean", value: backward },
            "SearchItem.Command": { type: "long", value: command },
          })
        }
      />
    </RibbonGroup>
  );
  const viewGroup = (
    <RibbonGroup label="View">
      <button type="button" title="Zoom out" aria-label="Zoom out" disabled={!ready} className={toolbarButtonClass()} onClick={() => zoomBy("out")}>
        <ZoomOut aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Zoom in" aria-label="Zoom in" disabled={!ready} className={toolbarButtonClass()} onClick={() => zoomBy("in")}>
        <ZoomIn aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </RibbonGroup>
  );

  // Per-app ribbon tabs (Wave C). Writer stays no-tab (its loved 2-band layout);
  // Calc/Impress use the tabbed shell composing the shared groups + their own.
  const tabDefs: RibbonTabDef[] =
    appType === "calc"
      ? [
          { id: "home", label: "Home" },
          { id: "number", label: "Number" },
          { id: "data", label: "Data" },
          { id: "view", label: "View" },
        ]
      : appType === "impress"
        ? [
            { id: "home", label: "Home" },
            { id: "insert", label: "Insert" },
            { id: "slide", label: "Slide" },
            { id: "present", label: "Present" },
            { id: "view", label: "View" },
          ]
        : [];
  const activeTabId = tabDefs.some((t) => t.id === activeTab) ? activeTab : (tabDefs[0]?.id ?? "home");

  return (
    <section
      className="grid h-full min-h-0 min-w-0 grid-rows-[auto_1fr] overflow-hidden bg-background"
      data-testid="office-doc-surface"
      onFocusCapture={publishOfficeContext}
    >
      <header className="grid min-w-0 grid-rows-[36px_auto] border-b border-border bg-background">
        <div className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {editingName ? (
              <input
                ref={renameInputRef}
                type="text"
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value);
                  setRenameError(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={() => {
                  if (isRenamingRef.current) void commitRename();
                }}
                className="min-w-0 flex-1 rounded border border-border-interactive bg-background-element px-1.5 py-0.5 text-sm font-medium text-foreground focus:outline-none"
                aria-label="Rename document"
                data-testid="office-doc-rename-input"
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void startRename()}
                  className="min-w-0 truncate rounded px-1 text-left text-sm font-medium text-foreground hover:bg-muted"
                  title={`${name} — click to rename`}
                  data-testid="office-doc-name"
                >
                  {name}
                </button>
                <button
                  type="button"
                  aria-label="Rename"
                  title="Rename"
                  onClick={() => void startRename()}
                  className="shrink-0 rounded p-1 text-foreground-muted hover:bg-muted hover:text-foreground"
                  data-testid="office-doc-rename"
                >
                  <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {renameError ? (
              <span className="shrink-0 text-[11px] text-[var(--error)]" title={renameError}>
                {renameError}
              </span>
            ) : null}
          </div>
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] tabular-nums ${
              saveState === "unsaved"
                ? "border-border-interactive bg-background-element text-foreground"
                : "border-border/60 bg-background-element text-foreground-muted"
            }`}
            data-testid="office-doc-save-status"
          >
            {saveStatusLabel}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {/* D362 §5b — parent-side "Exit presentation" button. Visible ONLY
                while the canvas slideshow is running (gated on `presenting`,
                subscribed via `subscribePresentationState`). A dedicated
                button (not a same-button toggle) because the ribbon is hidden
                when the iframe is browser-fullscreen; the in-fullscreen exit
                is Collabora's `#endshow` End Show button + browser-Escape,
                and this parent button covers the in-window fallback case
                where the iframe is NOT fullscreen. onClick ends the canvas
                path (`map.slideShowPresenter.endPresentation(true)`) AND
                sends `.uno:PresentationEnd` as a core-path kill switch. */}
            {presenting ? (
              <button
                type="button"
                aria-label="Exit presentation"
                title="Exit presentation"
                className="inline-flex items-center gap-1 rounded bg-primary-muted px-2 py-1 text-xs font-medium text-primary hover:bg-primary/15"
                onClick={exitPresentation}
                data-testid="office-doc-exit-presentation"
              >
                <Square aria-hidden="true" className="h-3 w-3" />
                Exit presentation
              </button>
            ) : null}
            {onToggleChat ? (
              <button
                type="button"
                aria-label={chatVisible ? `Hide ${assistantName}` : `Show ${assistantName}`}
                title={chatVisible ? `Hide ${assistantName}` : `Show ${assistantName}`}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-foreground-muted hover:bg-muted hover:text-foreground"
                onClick={onToggleChat}
              >
                {chatVisible ? (
                  <PanelRightClose aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <PanelRightOpen aria-hidden="true" className="h-3.5 w-3.5" />
                )}
              </button>
            ) : null}
            {onFocus ? (
              <button type="button" aria-label="Focus" title="Focus" className="rounded px-2 py-1 text-xs text-foreground-muted hover:bg-muted hover:text-foreground" onClick={onFocus}>
                <Focus aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            ) : null}
            <button type="button" className="rounded px-2 py-1 text-xs text-foreground-muted hover:bg-muted hover:text-foreground" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {/* Our Writer toolbar — drives the engine via Send_UNO_Command. Disabled
            until the document reports loaded. Two grouped rows keep the full
            control set visible without overloading one line (§3.3.5): row 1 =
            text, row 2 = paragraph + insert. Each row scrolls on a genuinely
            tiny width; a measured "…" overflow is a tracked follow-up. */}
        {/* Wave C — app-aware ribbon. Writer keeps its no-tab 2-band layout;
            Calc/Impress use the tabbed shell composing shared + app groups. */}
        <div className="flex flex-col" role="toolbar" aria-label="Formatting">
          {appType === "writer" ? (
            <div className="flex flex-col gap-1.5 px-2 py-1.5">
              <div className="flex min-w-0 items-stretch gap-1 overflow-x-auto" role="group" aria-label="Text formatting">
                {actionsGroup}
                {stylesGroup}
                {fontGroup}
              </div>
              <div className="flex min-w-0 items-stretch gap-1 overflow-x-auto" role="group" aria-label="Paragraph and insert">
                {paragraphGroup}
                {writerInsertGroup}
                {editingGroup}
                <WriterReviewGroup actions={actions} />
                {viewGroup}
              </div>
            </div>
          ) : (
            <>
              <RibbonTabStrip tabs={tabDefs} active={activeTabId} onSelect={setActiveTab} />
              <div className="flex min-w-0 items-stretch gap-1.5 overflow-x-auto px-2 py-1.5" role="group" aria-label="Formatting">
                {appType === "calc" && activeTabId === "home" && (
                  <>
                    {actionsGroup}
                    {fontGroup}
                    {alignGroup}
                    <CalcCellsGroup actions={actions} />
                  </>
                )}
                {appType === "calc" && activeTabId === "number" && <CalcNumberGroup actions={actions} />}
                {appType === "calc" && activeTabId === "data" && (
                  <>
                    <CalcDataGroup actions={actions} />
                    {editingGroup}
                  </>
                )}
                {appType === "calc" && activeTabId === "view" && <>{viewGroup}</>}
                {appType === "impress" && activeTabId === "home" && (
                  <>
                    {actionsGroup}
                    {fontGroup}
                    {paragraphGroup}
                  </>
                )}
                {appType === "impress" && activeTabId === "insert" && (
                  <>
                    <ImpressInsertGroup actions={actions} />
                    {writerInsertGroup}
                  </>
                )}
                {appType === "impress" && activeTabId === "slide" && (
                  <>
                    <ImpressSlideGroup actions={actions} onApplyLayout={applyLayout} />
                    {stylesGroup}
                  </>
                )}
                {appType === "impress" && activeTabId === "present" && (
                  <>
                    <ImpressPresentGroup actions={actions} />
                    {editingGroup}
                  </>
                )}
                {appType === "impress" && activeTabId === "view" && <>{viewGroup}</>}
              </div>
            </>
          )}
        </div>

        {/* Wave C (Calc) — formula bar: cell-ref box · fx · editable formula.
            Reads the active cell via `celladdress`/`cellformula`; commits with
            .uno:GoToCell (ref) / .uno:EnterString (formula). Live-verify pending. */}
        {appType === "calc" ? (
          <div className="flex min-w-0 items-center gap-1 border-t border-border/60 px-2 py-1" role="group" aria-label="Formula bar">
            <input
              type="text"
              aria-label="Cell reference"
              title="Cell reference"
              value={refDraft}
              disabled={!ready}
              onChange={(e) => setRefDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const r = refDraft.trim();
                  if (r !== "") sendUnoArgs(".uno:GoToCell", { ToPoint: { type: "string", value: r } });
                } else if (e.key === "Escape") {
                  setRefDraft(cellAddress);
                }
              }}
              className="w-24 shrink-0 rounded border border-border bg-background-element px-2 py-0.5 text-xs tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-border-interactive disabled:opacity-40"
            />
            <span className="shrink-0 select-none px-1 font-serif text-xs italic text-foreground-muted" aria-hidden="true">
              fx
            </span>
            <input
              type="text"
              aria-label="Formula"
              title="Formula"
              value={formulaDraft}
              disabled={!ready}
              onChange={(e) => setFormulaDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendUnoArgs(".uno:EnterString", { StringName: { type: "string", value: formulaDraft } });
                } else if (e.key === "Escape") {
                  setFormulaDraft(cellFormula);
                }
              }}
              className="min-w-0 flex-1 rounded border border-border bg-background-element px-2 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-border-interactive disabled:opacity-40"
            />
          </div>
        ) : null}

      </header>

      {error !== null ? (
        <div className="flex min-h-0 items-center justify-center p-8">
          <div className="max-w-md rounded-md border border-[var(--danger,#dc2626)]/40 bg-[var(--danger,#dc2626)]/10 p-4 text-sm text-foreground">
            <div className="mb-1 font-medium">Couldn’t open this document</div>
            <div className="text-foreground-muted">{error}</div>
          </div>
        </div>
      ) : editorUrl === null ? (
        <div className="flex min-h-0 items-center justify-center gap-2 text-sm text-foreground-muted">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          Opening {name}…
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 overflow-hidden bg-background">
          {/* Wave C (Impress) — slide rail on the left; reorder/add via slide verbs. */}
          {appType === "impress" ? (
            <ImpressSlideRail
              ready={ready}
              slides={slides}
              activeIndex={parts.selectedPart}
              onSelect={switchPart}
              onAdd={() => sendUno(".uno:InsertPage")}
              onDuplicate={() => sendUno(".uno:DuplicatePage")}
              onDelete={() => sendUno(".uno:DeletePage")}
              onMoveUp={() => sendUno(".uno:MovePageUp")}
              onMoveDown={() => sendUno(".uno:MovePageDown")}
            />
          ) : null}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
              <iframe
                ref={iframeRef}
                title={name}
                src={editorUrl}
                // D362 §5a — `allowFullScreen` + `allow="fullscreen"` so the
                // canvas slideshow's `presenterContainer.requestFullscreen()`
                // (`SlideShowPresenter.ts:1048-1063`) succeeds. Without these,
                // the request rejects and the slideshow falls back to the
                // in-window nested-iframe path (whose Escape reachability
                // depends on focus). With fullscreen granted, the browser owns
                // Escape-to-exitFullscreen → `_onFullScreenChange` →
                // `slideShowNavigator.quit()` → `endPresentation(true)`
                // (`SlideShowPresenter.ts:418-428`). `popups` is intentionally
                // NOT added (Presenter Console popup is deferred — see
                // investigation §5a).
                allow="clipboard-read; clipboard-write; fullscreen"
                allowFullScreen
                onLoad={() => injectChromeStrip(iframeRef.current)}
                className="min-h-0 min-w-0 border-0"
                style={{ width: "100%", height: "100%" }}
                data-testid="office-doc-iframe"
              />
              <div
                aria-hidden={visualReady}
                className={`absolute inset-0 z-10 flex items-center justify-center bg-background transition-opacity duration-200 ${
                  visualReady ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
              >
                <div className="flex items-center gap-2 rounded-md border border-border bg-background-panel px-3 py-2 text-xs text-foreground-muted shadow-sm">
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  Preparing document…
                </div>
              </div>
            </div>
            {/* Wave C (Calc) — sheet-tab bar below the grid: switch/add/delete/rename. */}
            {appType === "calc" ? (
              <CalcSheetTabs
                ready={ready}
                sheets={sheets}
                activeIndex={parts.selectedPart}
                onSwitch={switchPart}
                onAdd={() =>
                  sendUnoArgs(".uno:Insert", {
                    Name: { type: "string", value: "" },
                    Index: { type: "long", value: parts.count + 1 },
                  })
                }
                onDelete={(index) =>
                  sendUnoArgs(".uno:Remove", { Index: { type: "long", value: index + 1 } })
                }
                onRename={(index, newName) =>
                  sendUnoArgs(".uno:Name", {
                    Name: { type: "string", value: newName },
                    Index: { type: "long", value: index + 1 },
                  })
                }
              />
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
