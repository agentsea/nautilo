/**
 * D362 Milestone B — coolwsd WebSocket session client.
 *
 * A minimal line-protocol client for Collabora Online's coolwsd WebSocket
 * (per `/EXTERNAL/collabora-online-source/wsd/protocol.txt`). It speaks
 * just enough of the protocol to drive an agent-side edit against a
 * live workspace doc: handshake (`coolclient` + `load url=`), UNO
 * commands (`uno <cmd> [json]`), and `save`. The agent opens a session,
 * runs one or more UNO commands, saves, and closes. coolwsd holds the
 * WOPI lock for the duration and serializes edits; the save flows back
 * through WOPI PutFile → the existing revision-bump + SSE path in
 * `packages/server/src/routes/wopi.ts`, so a human editor with the doc
 * open sees the change live.
 *
 * Uses Bun's NATIVE `WebSocket` global — no extra deps. Binary / tile
 * traffic is ignored entirely; we never request tiles and we never send
 * `tileprocessed`. Only the first line (up to `\n`) of each frame is
 * parsed as the text command.
 *
 * Tolerant save: per protocol.txt §save, a successful save is signalled
 * either by an `unocommandresult:` for `.uno:Save` (preferred) OR by
 * the engine clearing the modified flag (a `statechanged:` whose
 * payload carries `.uno:ModifiedStatus` with state `false`). We also
 * tolerate `error: cmd=storage …` as a save failure (rejects).
 */

/** Optional args for a UNO command: a map of `{ argName: { type, value } }`. */
export type UnoArgs = Record<string, { type: string; value: unknown }>;

/** Structural surface the office tool relies on — `CoolSessionClient` satisfies this. */
export interface CoolSessionLike {
  connect(): Promise<void>;
  sendUno(command: string, args?: UnoArgs): void;
  /**
   * Send a UNO command and wait for its ack. `timeoutMs` overrides the
   * session default for THIS wait only — callers that treat the ack as a
   * best-effort hint (not load-bearing) should pass a short timeout and
   * handle the timeout rejection by proceeding.
   */
  sendUnoAndWait(command: string, args?: UnoArgs, timeoutMs?: number): Promise<unknown>;
  save(): Promise<void>;
  /**
   * Fire-and-forget save: send the `save` command WITHOUT awaiting an
   * ack. coolwsd's `.uno:Save` / `ModifiedStatus=false` acks are not
   * reliably emitted, so callers that verify persistence out-of-band
   * (e.g. by polling the saved bytes on disk — the durability gate) must
   * NOT depend on the ack. This performs the PutFile side-effect and
   * returns immediately, leaving no pending wait to collide with a later
   * `save()` on a reused session.
   */
  requestSave(): void;
  /**
   * Force an immediate WOPI storage upload (`savetostorage force=1`).
   *
   * A plain `save` flushes the Kit to coolwsd's local temp file but only
   * uploads to storage via `uploadToStorage(force=false)`, which coolwsd
   * DEFERS under its upload throttle (`min_time_between_uploads_ms`) or a
   * "storage changed behind our back" conflict — so the WOPI PutFile can
   * lag tens of seconds (observed live: ~40s, landing on the 30s idle
   * autosave). `savetostorage force=1` calls `uploadToStorage(force=true)`,
   * which uploads immediately. It uploads the LAST SAVED local temp, so it
   * only changes the on-disk bytes once a preceding `save` has actually
   * written the new content — safe to fire repeatedly while polling.
   */
  saveToStorage(): void;
  /**
   * Switch the active part (sheet in Calc, slide in Impress) to the
   * 0-based `n`. Sends the coolwsd `setclientpart part=<n>` socket
   * message — NOT a UNO command. Grounded at
   * `EXTERNAL/collabora-online-source/browser/src/control/Parts.js:88`
   * (`app.socket.sendMessage('setclientpart part=' + part)`).
   * Fire-and-forget — coolwsd's `partinfoback:`/`statechanged:` replies
   * are not load-bearing for the agent path.
   */
  setClientPart(n: number): void;
  /**
   * Emit a LOK `mouse` socket event for coordinate-based placement.
   * `type` ∈ "buttondown" | "buttonup" | "move"; `x`/`y` are in
   * **twips** (1 inch = 1440 twips, 1 cm ≈ 566.93 twips). `buttons` is
   * the LOK button mask (1 = left, 2 = middle, 4 = right); `modifier`
   * is the keyboard-modifier mask (0 = none). The wire format is
   * `mouse type=<type> x=<x> y=<y> count=1 buttons=<buttons> modifier=<modifier>`
   * — grounded at
   * `EXTERNAL/collabora-online-source/browser/src/layer/tile/CanvasTileLayer.js:2667-2669`
   * (`app.socket.sendMessage('mouse type=' + type + ' x=' + x + ' y=' + y + ' count=' + count + ' buttons=' + buttons + ' modifier=' + modifier)`),
   * with twips coordinates confirmed by `CursorHandler.ts:62-63`
   * (`Math.round(this.position[0] * app.pixelsToTwips)`). `count` is
   * hard-coded to 1 (single click); the agent path does not synthesize
   * double/triple clicks.
   */
  sendMouse(
    type: "buttondown" | "buttonup" | "move",
    x: number,
    y: number,
    buttons: number,
    modifier: number,
  ): void;
  /**
   * Type text into the active text-edit target (e.g. a shape whose text-edit
   * was just entered via `.uno:Text?CreateDirectly:bool=true`). This is the
   * ONLY reliable way to get text INTO a draw/impress text box — `.uno:InsertText`
   * does not route into an active shape outliner, leaving the box empty (and a
   * new empty text frame is auto-culled on end-edit: svx svdedxv.cxx:1797).
   * Grounded wire at `browser/src/layer/marker/TextInput.js:1225-1229`:
   * `textinput id=<winId> text=<encodeURIComponent(text)>`; winId is 0 for the
   * main document view. Fire-and-forget.
   */
  sendTextInput(text: string): void;
  /**
   * Request a fresh `childid` from coolwsd and await its `getchildid:` reply.
   *
   * GROUNDED in Collabora's `Map.FileInserter.js` image-insert flow:
   * `app.socket.sendMessage('getchildid')` (line 50) → engine replies
   * `getchildid: id=<id>` (parsed at `CanvasTileLayer.js:848-850` +
   * `_onGetChildIdMsg:1611-1613` → fires `childid {id: command.id}` where
   * `command.id` is the `id=` token of the wire line, per
   * `ServerCommand.ts:97-99`). The childid identifies the doc-broker jail
   * the upload is written to; coolwsd 400s an insertfile POST whose childid
   * doesn't match (`ClientRequestDispatcher.cpp:2279-2296`).
   *
   * Mirrors `getCommandState`'s send-and-await pattern: sends `getchildid`,
   * awaits the next `getchildid:` reply up to `timeoutMs` (defaults to the
   * session timeout), resolves with the id string OR `null` on timeout /
   * disconnect / malformed reply. The caller treats `null` as a hard failure
   * (image insert is not retryable without a childid).
   */
  getChildId(timeoutMs?: number): Promise<string | null>;
  /**
   * Server-side multipart POST to coolwsd's insertfile endpoint — the bytes
   * path for image insert (`Map.FileInserter.js:_sendFile:228-285`). NOT a
   * browser API: the agent has the file bytes; this fetch carries them to
   * the engine's `<serviceRoot>/cool/<WOPISrc>/insertfile` route through
   * the same loopback the office reverse-proxy uses (the proxy is
   * wire-verified for multipart POSTs via `1b5bbfb3`).
   *
   * Builds `multipart/form-data` with three fields — `name`, `childid`,
   * `file` (Blob with filename + content type) — exactly the form
   * `Map.FileInserter.js:261-285` posts. Rejects on non-2xx (the engine
   * returns 400 for a wrong childid, 404 for an unknown doc, 413 for too
   * large — see `Map.FileInserter.js:247-257`).
   */
  postInsertFile(
    name: string,
    childId: string,
    file: { bytes: Uint8Array; filename: string; contentType: string },
  ): Promise<void>;
  /**
   * Emit the `insertfile name=<name> type=<type>` socket line that tells
   * coolwsd to insert the previously-uploaded file. Grounded at
   * `Map.FileInserter.js:244` (`socket.sendMessage('insertfile name=' +
   * name + ' type=' + type)` — the post-upload trigger for type='graphic').
   * Fire-and-forget — coolwsd applies the insert async; the save +
   * durability gate is the sync point. NOT a UNO command (no `uno ` prefix).
   */
  sendInsertFile(name: string, type: string): void;
  close(): void;
  /**
   * Cheap liveness probe — true iff the underlying WS is open. Used by the
   * session manager to detect rare early death (engine restart) without a
   * round-trip; covers the gap between idle-close windows.
   */
  isAlive(): boolean;
  /**
   * Capture the just-selected graphic's rect by awaiting the next
   * `graphicselection:` push from coolwsd. Returns the latest cached rect
   * if one is present (cleared via `clearGraphicSelectionCache`), otherwise
   * awaits the next non-EMPTY `graphicselection:` push up to `timeoutMs`
   * (defaults to the session timeout). Resolves `null` on timeout /
   * disconnect / EMPTY selection / malformed payload.
   *
   * GROUNDED — coolwsd has NO client→server "request current selection"
   * primitive. The wire pushes `graphicselection: <json-array>` whenever a
   * graphic is selected (`EXTERNAL/collabora-online-source/wsd/ClientSession.cpp:2637`
   * forwards it; `EXTERNAL/collabora-online-source/browser/src/app/GraphicSelectionMiddleware.ts:328-355`
   * parses it: `textMsg = '[' + textMsg.substr('graphicselection:'.length) + ']'; JSON.parse(textMsg)`
   * → `extractAndSetGraphicSelection(msgData)` constructs
   * `rectangle = new SimpleRectangle(msgData[0], msgData[1], msgData[2],
   * msgData[3])`). The payload is `[x1, y1, x2, y2, angle?, extraInfo?]` in
   * **twips**; an `EMPTY` payload clears the selection. The agent path
   * treats EMPTY as null (no rect to size against).
   *
   * The agent image-insert flow relies on coolwsd selecting the
   * just-inserted graphic (default kit behavior: a fresh insert becomes the
   * current selection, pushing `graphicselection:` with the new shape's
   * rect). To guarantee a FRESH post-insert rect (not a stale one from a
   * prior selection), call `clearGraphicSelectionCache()` immediately
   * BEFORE the `insertfile` trigger, then `getGraphicSelection()` after.
   *
   * OPTIONAL on the interface (same rationale as `getCommandState`) so
   * existing fake sessions in office tool tests continue to typecheck
   * without edit.
   */
  getGraphicSelection?(timeoutMs?: number): Promise<{ x1: number; y1: number; x2: number; y2: number } | null>;
  /**
   * Clear the cached latest `graphicselection:` rect. Call this immediately
   * BEFORE the `insertfile` trigger so a subsequent `getGraphicSelection()`
   * returns a FRESH post-insert rect (not a stale one from a prior
   * selection). Fire-and-forget — no wire traffic.
   */
  clearGraphicSelectionCache?(): void;
  /**
   * Read the engine's current state for a `.uno:` command (e.g.
   * `.uno:TrackChanges` → true/false, `.uno:Undo` → "enabled"/"disabled").
   * Returns the cached last-seen state if coolwsd has pushed one; otherwise
   * awaits the next `statechanged:` push for that command up to `timeoutMs`
   * (defaults to the session timeout) and resolves with it, or `null` on
   * timeout / unknown state / disconnected socket.
   *
   * GROUNDED — coolwsd has NO client→server "request current state"
   * primitive in the wire protocol. `EXTERNAL/collabora-online-source/wsd/protocol.txt:658-661`
   * lists only `statechanged: <key>=<value>` (server→client push); the
   * `commandvalues command=<UNOCommand>` primitive at line 375 is for
   * value-sets (font lists, annotations), NOT toggle state. The browser
   * client follows the same cache+push pattern: `Map.StateChanges.js:52`
   * (`this._items[commandName] = state`) read via `getItemValue` (line 158).
   * Wire parsing handles BOTH forms grounded at
   * `EXTERNAL/collabora-online-source/browser/src/layer/tile/CanvasTileLayer.js:2102-2130`
   * (`<key>=<value>` split on first `=`, OR JSON `{commandName,state}`).
   *
   * coolwsd pushes states on doc load and on selection/cursor moves — a
   * fresh push for a GIVEN command within `timeoutMs` is NOT guaranteed
   * unless something triggers a re-evaluation (cursor move, tool toggle,
   * part switch). Callers that need a guaranteed-fresh value should prime
   * the cache first (e.g. a no-op `.uno:GoToCell` for Calc, or wait for
   * the next selection event) before awaiting.
   *
   * // LIVE-VERIFY: that a stale cache hit reflects the CURRENT engine
   * // state for `.uno:TrackChanges` after an external toggle — the engine
   * // does push a `statechanged:` on every toggle, so the cache should be
   * // fresh whenever the agent is the toggle author; the risk is a
   * // concurrent human editor toggling in parallel.
   *
   * OPTIONAL on the interface so existing fake sessions in
   * `packages/agent/src/tools/office/*.test.ts` (which implement
   * `CoolSessionLike` as object literals) continue to typecheck without
   * edit. The production `CoolSessionClient` implements it concretely.
   * The orchestrator may want to upgrade it to required once the agent
   * fakes are updated in a follow-up.
   */
  getCommandState?(command: string, timeoutMs?: number): Promise<string | boolean | null>;
}

export interface CoolSessionOptions {
  /** ws:// (or wss://) origin of the coolwsd engine, e.g. `ws://localhost:9980`. */
  wsBaseUrl: string;
  /** Full WOPI doc URL the engine should load (already includes `access_token=…`). */
  docUrl: string;
  /** The WOPI source URL the engine uses to call back CheckFileInfo / GetFile / PutFile. */
  wopiSrc: string;
  /**
   * coolwsd service-root path prefix (its `--o:net.service_root`, e.g.
   * `/office-engine`). The WS endpoint lives at `<serviceRoot>/cool/…/ws`;
   * omitting it makes coolwsd drop the upgrade (close 1002). Default "".
   */
  serviceRoot?: string;
  /**
   * `Origin` header for the WS upgrade. coolwsd validates it against its
   * `--o:server_name` and closes the socket (1002) if absent/mismatched.
   * Must equal the engine's configured `server_name` (e.g. `http://127.0.0.1:3001`).
   */
  origin?: string;
  /** Per-operation timeout. Default 15000ms. */
  timeoutMs?: number;
}

/**
 * Read the intrinsic pixel dimensions of an image from its header bytes —
 * PNG (IHDR at offset 16: width/height big-endian uint32) and JPEG (scan
 * SOF0/SOF2 markers 0xFFC0/0xFFC2 for height/width). Returns `{w, h}` in
 * PIXELS, or `null` for unrecognized / truncated / malformed payloads.
 *
 * This is the DETERMINISTIC native-aspect source for `insert_image`
 * placement: parsing the image header gives the aspect ratio WITHOUT
 * depending on a runtime coolwsd `graphicselection:` echo (which is not
 * wire-guaranteed within any bounded window). The caller derives the
 * placement rect from the aspect + the real slide size — no live echo
 * needed.
 *
 * PNG: signature is 8 bytes (`89 50 4E 47 0D 0A 1A 0A`), then the IHDR
 * chunk: 4-byte length, 4-byte "IHDR", 4-byte width (BE uint32), 4-byte
 * height (BE uint32). Width is at offset 16, height at offset 20.
 *
 * JPEG: starts with `FF D8`. Segments are `FF <marker> <length BE uint16>
 * <payload>`. The Start-of-Frame markers (SOF0=`FFC0`, SOF2=`FFC2`, plus
 * the rest of the SOF family `FFC1/FFC3..FFC5/FFC6/FFC7/FFC9/FFCA/FFCB/
 * FFCD/FFCE/FFCF`) carry the frame dimensions: after the 2-byte length,
 * 1 byte precision, 2 bytes height (BE), 2 bytes width (BE). We scan
 * markers from the start; the first SOF we hit carries the dims. SOF4
 * (`FFC4`=DHT), SOF8 (`FFC8`=JPG), and SOF12 (`FFCC`=DAC) are NOT frame
 * markers and are skipped.
 *
 * Returns `null` for: unknown magic bytes, truncated headers, a JPEG with
 * no SOF segment encountered within the buffer, or non-finite parsed
 * dims. The caller treats `null` as "unknown aspect" and falls back to
 * the slide aspect for the placement compute (still deterministic).
 */
export function readImagePixelSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (!bytes || bytes.length < 8) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR width/height at offset 16/20.
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    if (bytes.length < 24) return null;
    // IHDR signature check (bytes 12..15 = "IHDR").
    if (!(bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52)) {
      return null;
    }
    const w = (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!;
    const h = (bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { w: w >>> 0, h: h >>> 0 };
  }
  // JPEG: FF D8 then a sequence of segments. Scan for an SOF marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 3 < bytes.length) {
      if (bytes[i] !== 0xff) return null; // malformed segment stream
      // Skip padding 0xff bytes (JPEG spec allows filler 0xff before a marker).
      while (i < bytes.length && bytes[i] === 0xff) i++;
      if (i >= bytes.length) return null;
      const marker = bytes[i]!;
      i++;
      // SOI (D8) / EOI (D9) / SOS (DA) — no length field; SOS means we
      // passed the metadata without finding an SOF (rare for well-formed
      // JPEGs, which carry SOF before SOS).
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (marker === 0xda) return null;
      // Standalone markers (RSTn D0..D7, TEM 01) have no length field.
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      if (i + 1 >= bytes.length) return null;
      const segLen = (bytes[i]! << 8) | bytes[i + 1]!;
      if (segLen < 2) return null;
      // SOF markers: C0,C1,C2,C3,C5,C6,C7,C9,CA,CB,CD,CE,CF (NOT C4=DHT,
      // C8=JPG, CC=DAC). Payload after length: 1 byte precision, 2 bytes
      // height (BE), 2 bytes width (BE).
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        // Need 1 (precision) + 2 (height) + 2 (width) = 5 bytes after segLen.
        if (i + 1 + 5 > bytes.length) return null;
        const h = (bytes[i + 3]! << 8) | bytes[i + 4]!;
        const w = (bytes[i + 5]! << 8) | bytes[i + 6]!;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
        return { w, h };
      }
      // Skip past this segment's payload (segLen includes the 2-byte length).
      i += segLen;
    }
    return null;
  }
  return null;
}

/** Bun's `WebSocket` accepts a non-standard `{ headers }` init; typed locally to avoid `any`. */
type WebSocketWithHeaders = {
  new (url: string, options?: { headers?: Record<string, string> }): WebSocket;
};

/** Default per-op timeout — handshake, uno-wait, save all bounded by this. */
const DEFAULT_TIMEOUT_MS = 15_000;

export class CoolSessionClient implements CoolSessionLike {
  private readonly wsBaseUrl: string;
  private readonly docUrl: string;
  private readonly wopiSrc: string;
  private readonly serviceRoot: string;
  private readonly origin: string | undefined;
  private readonly timeoutMs: number;
  private ws: WebSocket | null = null;
  /** Buffered text from a binary frame — we accumulate until we hit `\n`. */
  private pendingText = "";
  /** Resolver for the in-flight `sendUnoAndWait` (set when awaiting `unocommandresult:`). */
  private unoWait: {
    command: string;
    resolve: (payload: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** Resolver for the in-flight `save()` (awaiting uno:Save result / ModifiedStatus=false). */
  private saveWait: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** Resolver for `connect()` — awaits `loaded:`/`status:` with a viewid. */
  private connectWait: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /**
   * Last-seen engine state per `.uno:` command, populated from
   * `statechanged:` pushes. Mirrors the browser's `Map.StateChanges.js`
   * `_items` cache (`EXTERNAL/collabora-online-source/browser/src/map/handler/Map.StateChanges.js:18,52`).
   * Values are normalized: `"true"`/`"false"` → boolean, other strings
   * kept as-is (e.g. `"enabled"`, `"disabled"`).
   */
  private readonly commandStateCache = new Map<string, string | boolean>();
  /**
   * Pending `getCommandState` waiters awaiting their first `statechanged:`
   * push for a given command. Keyed by normalized `.uno:Name`. Multiple
   * concurrent waiters per command are supported (FIFO resolve).
   */
  private readonly commandStateWaiters = new Map<
    string,
    Array<{ resolve: (v: string | boolean | null) => void; timer: ReturnType<typeof setTimeout> }>
  >();
  /**
   * Resolver for the in-flight `getChildId()` (awaiting `getchildid:` reply).
   * At most one at a time — the image-insert flow is single-writer; a second
   * concurrent call rejects the first still-pending waiter defensively.
   */
  private childIdWait: {
    resolve: (id: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /**
   * Latest non-EMPTY `graphicselection:` rectangle pushed by coolwsd, in
   * **twips**. Cleared by `clearGraphicSelectionCache()` (so a caller can
   * guarantee a fresh post-trigger read) and by an `EMPTY` push (the kit
   * deselected). Mirrors the `commandStateCache` pattern.
   */
  private graphicSelectionRect: { x1: number; y1: number; x2: number; y2: number } | null = null;
  /**
   * Pending `getGraphicSelection` waiters awaiting their first non-EMPTY
   * `graphicselection:` push. Single queue — multiple concurrent waiters
   * are supported (FIFO resolve on the next push).
   */
  private readonly graphicSelectionWaiters = new Map<
    number,
    { resolve: (v: { x1: number; y1: number; x2: number; y2: number } | null) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /**
   * Monotonic counter used to key `graphicSelectionWaiters` so concurrent
   * waiters don't collide on a Map key. Incremented per `getGraphicSelection`
   * call.
   */
  private graphicSelectionWaiterSeq = 0;
  private closed = false;

  constructor(opts: CoolSessionOptions) {
    if (!opts.wsBaseUrl) throw new Error("CoolSessionClient: wsBaseUrl is required");
    if (!opts.docUrl) throw new Error("CoolSessionClient: docUrl is required");
    if (!opts.wopiSrc) throw new Error("CoolSessionClient: wopiSrc is required");
    this.wsBaseUrl = opts.wsBaseUrl.replace(/\/+$/, "");
    this.docUrl = opts.docUrl;
    this.wopiSrc = opts.wopiSrc;
    // Normalize serviceRoot to "" or "/prefix" (no trailing slash).
    this.serviceRoot = opts.serviceRoot ? "/" + opts.serviceRoot.replace(/^\/+|\/+$/g, "") : "";
    this.origin = opts.origin;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Open the WS, send `coolclient 0.1 <ts> <perf>`, send `load url=<docUrl>`,
   * and resolve once a `loaded:` (or `status:`) message carrying a viewid
   * arrives. Rejects on `error:`, timeout, or socket close before load.
   */
  connect(): Promise<void> {
    if (this.ws) return Promise.resolve();
    const url =
      `${this.wsBaseUrl}${this.serviceRoot}/cool/${encodeURIComponent(this.docUrl)}/ws` +
      `?WOPISrc=${encodeURIComponent(this.wopiSrc)}`;

    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        // coolwsd validates the WS `Origin` against its server_name; pass it
        // via Bun's non-standard `{ headers }` init or the upgrade is dropped.
        const WS = WebSocket as unknown as WebSocketWithHeaders;
        ws = this.origin
          ? new WS(url, { headers: { Origin: this.origin } })
          : new WS(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // We always send text frames; receive both text and binary (binary
      // carries tile payloads we ignore — first line is still the command).
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      const timer = setTimeout(() => {
        if (this.connectWait) {
          this.connectWait = null;
          reject(new Error("cool-session: connect timeout"));
          this.teardown();
        }
      }, this.timeoutMs);
      this.connectWait = { resolve, reject, timer };

      ws.onopen = () => {
        const ts = Date.now();
        const perf = performance.now();
        this.sendRaw(`coolclient 0.1 ${ts} ${perf}`);
        this.sendRaw(`load url=${encodeURIComponent(this.docUrl)}`);
      };
      ws.onerror = () => {
        // The close handler surfaces the final failure; onerror is just a hint.
        // If the socket never opened, close may not carry a useful code.
      };
      ws.onclose = () => {
        if (this.connectWait) {
          const w = this.connectWait;
          this.connectWait = null;
          clearTimeout(w.timer);
          w.reject(new Error("cool-session: socket closed before load"));
        }
      };
      ws.onmessage = (ev) => this.onMessage(ev);
    });
  }

  /** Fire-and-forget UNO command. */
  sendUno(command: string, args?: UnoArgs): void {
    const payload = args ? `${command} ${JSON.stringify(args)}` : command;
    this.sendRaw(`uno ${payload}`);
  }

  /**
   * Send a UNO command and resolve with the matching `unocommandresult:` payload
   * (parsed JSON). Rejects on `error:` for that command or timeout.
   */
  sendUnoAndWait(command: string, args?: UnoArgs, timeoutMs?: number): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("cool-session: not connected"));
    }
    if (this.unoWait) {
      return Promise.reject(new Error("cool-session: a sendUnoAndWait is already in flight"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.unoWait) {
          this.unoWait = null;
          reject(new Error(`cool-session: uno '${command}' timed out`));
        }
      }, timeoutMs ?? this.timeoutMs);
      this.unoWait = { command, resolve, reject, timer };
      this.sendUno(command, args);
    });
  }

  /**
   * Send `save dontTerminateEdit=1 dontSaveIfUnmodified=0` and resolve when
   * the engine acknowledges — either an `unocommandresult:` for `.uno:Save`
   * (success) or a `statechanged:` carrying `.uno:ModifiedStatus` state
   * `false` (the doc-is-no-longer-dirty signal). Rejects on `error:` or
   * timeout.
   */
  save(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("cool-session: not connected"));
    }
    if (this.saveWait) {
      return Promise.reject(new Error("cool-session: a save is already in flight"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.saveWait) {
          this.saveWait = null;
          reject(new Error("cool-session: save timed out"));
        }
      }, this.timeoutMs);
      this.saveWait = { resolve, reject, timer };
      this.sendRaw("save dontTerminateEdit=1 dontSaveIfUnmodified=0");
    });
  }

  /**
   * Fire-and-forget save. Sends the same `save` line as `save()` but sets
   * up no `saveWait` and no timer — the caller verifies persistence by
   * other means (the durability gate). Safe to call repeatedly on a
   * reused session; it can never leave a pending wait behind.
   */
  requestSave(): void {
    this.sendRaw("save dontTerminateEdit=1 dontSaveIfUnmodified=0");
  }

  /** Force an immediate storage upload — see interface doc. Fire-and-forget. */
  saveToStorage(): void {
    this.sendRaw("savetostorage force=1");
  }

  /** Switch the active part (Calc sheet / Impress slide). See interface doc. */
  setClientPart(n: number): void {
    this.sendRaw(`setclientpart part=${n}`);
  }

  /**
   * Emit a LOK `mouse` socket event. See interface doc — coordinates in
   * twips, `count` hard-coded to 1.
   */
  sendMouse(
    type: "buttondown" | "buttonup" | "move",
    x: number,
    y: number,
    buttons: number,
    modifier: number,
  ): void {
    this.sendRaw(`mouse type=${type} x=${x} y=${y} count=1 buttons=${buttons} modifier=${modifier}`);
  }

  /** Type text into the active text-edit target — see interface doc. Grounded
   * `textinput id=<winId> text=<encodeURIComponent>` (TextInput.js:1225-1229);
   * winId=0 (main document view). */
  sendTextInput(text: string): void {
    this.sendRaw(`textinput id=0 text=${encodeURIComponent(text)}`);
  }

  /**
   * Request a childid and await the `getchildid:` reply. See interface doc
   * for grounding + the `getCommandState` mirror pattern. Resolves null on
   * timeout / disconnect / malformed payload (no `id=` token).
   */
  getChildId(timeoutMs?: number): Promise<string | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(null);
    }
    if (this.childIdWait) {
      // Single writer. A second concurrent call is a caller bug — resolve
      // the first as null so its caller surfaces a clean failure rather than
      // silently hanging on a reply the second call will consume.
      const prev = this.childIdWait;
      this.childIdWait = null;
      clearTimeout(prev.timer);
      prev.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.childIdWait && this.childIdWait.resolve === resolve) {
          this.childIdWait = null;
          resolve(null);
        }
      }, timeoutMs ?? this.timeoutMs);
      this.childIdWait = { resolve, timer };
      this.sendRaw("getchildid");
    });
  }

  /**
   * Server-side multipart POST to coolwsd's insertfile endpoint. See
   * interface doc for grounding. Builds the URL from the session's
   * `wsBaseUrl` (ws→http swap) + `serviceRoot` + the encoded `docUrl`
   * + `WOPISrc` query — exactly the form `Map.FileInserter.js:27`
   * (`getWopiUrl`) assembles via `makeHttpUrlWopiSrc` + `makeDocAndWopiSrcUrl`
   * (`global.js:1770-1789`). Rejects on non-2xx with the engine status so
   * the caller can distinguish 400 (bad childid) / 404 (no doc) / 413 (too
   * large).
   */
  async postInsertFile(
    name: string,
    childId: string,
    file: { bytes: Uint8Array; filename: string; contentType: string },
  ): Promise<void> {
    const httpBase = this.httpBaseUrl();
    const url =
      `${httpBase}${this.serviceRoot}/cool/${encodeURIComponent(this.docUrl)}/insertfile` +
      `?WOPISrc=${encodeURIComponent(this.wopiSrc)}&compat=`;
    const form = new FormData();
    form.append("name", name);
    form.append("childid", childId);
    form.append(
      "file",
      new Blob([file.bytes], { type: file.contentType }),
      file.filename,
    );
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(
        `cool-session: insertfile POST failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`cool-session: insertfile POST returned HTTP ${res.status}`);
    }
  }

  /** Emit `insertfile name=<name> type=<type>` — see interface doc. */
  sendInsertFile(name: string, type: string): void {
    this.sendRaw(`insertfile name=${name} type=${type}`);
  }

  /** Derive the HTTP base from the WS base (ws:// → http://, wss:// → https://). */
  private httpBaseUrl(): string {
    const base = this.wsBaseUrl;
    if (base.startsWith("wss://")) return "https://" + base.slice("wss://".length);
    if (base.startsWith("ws://")) return "http://" + base.slice("ws://".length);
    return base;
  }

  /** Graceful WS close. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
  }

  /** True iff the underlying WS is in the OPEN state (cheap; no round-trip). */
  isAlive(): boolean {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /**
   * Read the engine's current state for a `.uno:` command. See interface
   * doc for grounding + the cache+await push model. Cache hit → immediate
   * resolve; miss → await next `statechanged:` for that command, or
   * `null` on timeout / disconnect.
   */
  getCommandState(command: string, timeoutMs?: number): Promise<string | boolean | null> {
    const key = this.normalizeCommandName(command);
    const cached = this.commandStateCache.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Disconnected — no way to await a push. Resolve null rather than
      // hang; callers can distinguish "unknown" from "definitely false"
      // by checking `isAlive()` first if it matters.
      return Promise.resolve(null);
    }
    return new Promise<string | boolean | null>((resolve) => {
      const timer = setTimeout(() => {
        const arr = this.commandStateWaiters.get(key);
        if (arr) {
          const idx = arr.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.commandStateWaiters.delete(key);
        }
        resolve(null);
      }, timeoutMs ?? this.timeoutMs);
      const arr = this.commandStateWaiters.get(key) ?? [];
      arr.push({ resolve, timer });
      this.commandStateWaiters.set(key, arr);
    });
  }

  /**
   * Await the next non-EMPTY `graphicselection:` push and resolve with the
   * rect in twips, OR resolve `null` on timeout / disconnect / malformed
   * payload. Returns the cached latest rect if one is present (call
   * `clearGraphicSelectionCache` first to force a fresh read). See interface
   * doc for grounding.
   */
  getGraphicSelection(timeoutMs?: number): Promise<{ x1: number; y1: number; x2: number; y2: number } | null> {
    if (this.graphicSelectionRect !== null) {
      return Promise.resolve(this.graphicSelectionRect);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(null);
    }
    const seq = this.graphicSelectionWaiterSeq++;
    return new Promise<{ x1: number; y1: number; x2: number; y2: number } | null>((resolve) => {
      const timer = setTimeout(() => {
        const w = this.graphicSelectionWaiters.get(seq);
        if (w && w.resolve === resolve) {
          this.graphicSelectionWaiters.delete(seq);
        }
        resolve(null);
      }, timeoutMs ?? this.timeoutMs);
      this.graphicSelectionWaiters.set(seq, { resolve, timer });
    });
  }

  /** Clear the cached latest `graphicselection:` rect. See interface doc. */
  clearGraphicSelectionCache(): void {
    this.graphicSelectionRect = null;
  }

  // ─── internals ──────────────────────────────────────────────────────

  private sendRaw(line: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(line);
  }

  private teardown(): void {
    if (this.unoWait) {
      const w = this.unoWait;
      this.unoWait = null;
      clearTimeout(w.timer);
      w.reject(new Error("cool-session: closing before uno result"));
    }
    if (this.saveWait) {
      const w = this.saveWait;
      this.saveWait = null;
      clearTimeout(w.timer);
      w.reject(new Error("cool-session: closing before save result"));
    }
    if (this.connectWait) {
      const w = this.connectWait;
      this.connectWait = null;
      clearTimeout(w.timer);
      w.reject(new Error("cool-session: closing before load"));
    }
    if (this.commandStateWaiters.size > 0) {
      // Resolve pending `getCommandState` waiters with null on close —
      // they cannot receive a push after the socket is gone.
      for (const arr of this.commandStateWaiters.values()) {
        for (const w of arr) {
          clearTimeout(w.timer);
          w.resolve(null);
        }
      }
      this.commandStateWaiters.clear();
    }
    if (this.childIdWait) {
      // Resolve a pending `getChildId` with null on close — the reply
      // cannot arrive after the socket is gone.
      const w = this.childIdWait;
      this.childIdWait = null;
      clearTimeout(w.timer);
      w.resolve(null);
    }
    if (this.graphicSelectionWaiters.size > 0) {
      // Resolve pending `getGraphicSelection` waiters with null on close —
      // a push cannot arrive after the socket is gone.
      for (const w of this.graphicSelectionWaiters.values()) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
      this.graphicSelectionWaiters.clear();
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, "client-done");
        }
      } catch {
        // ignore
      }
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.onmessage = null;
    }
  }

  /** Decode a WS message to its first-line text command. Ignores binary tails. */
  private textFromEvent(ev: MessageEvent): string | null {
    let data: ArrayBuffer | string;
    if (ev.data instanceof ArrayBuffer) {
      data = ev.data;
    } else if (typeof ev.data === "string") {
      data = ev.data;
    } else if (ev.data instanceof Blob) {
      // Bun's WebSocket doesn't currently emit Blob for binaryType=arraybuffer,
      // but defend against it so a future runtime change doesn't break us.
      // Synchronous decode isn't possible for Blob; fall through and ignore.
      return null;
    } else {
      return null;
    }

    let text: string;
    if (typeof data === "string") {
      text = data;
    } else {
      // ArrayBuffer — first line up to `\n` is the command; tail is tile bytes.
      const bytes = new Uint8Array(data);
      const nl = bytes.indexOf(0x0a);
      const lineBytes = nl === -1 ? bytes : bytes.subarray(0, nl);
      text = new TextDecoder("utf-8", { fatal: false }).decode(lineBytes);
      if (nl === -1) {
        // No newline yet — accumulate and wait for more. (Coolwsd text
        // commands are single-frame, so this is rare; tolerate it anyway.)
        this.pendingText += text;
        return null;
      }
      text = this.pendingText + text;
      this.pendingText = "";
    }
    return text;
  }

  private onMessage(ev: MessageEvent): void {
    const text = this.textFromEvent(ev);
    if (text === null || text.length === 0) return;
    this.dispatch(text);
  }

  /** Route one text command line. */
  private dispatch(text: string): void {
    // `error:` — fails whichever wait is in flight (or ignored if none).
    if (text.startsWith("error:")) {
      const cmd = this.parseErrorCommand(text);
      const err = new Error(`cool-session: server error: ${text}`);
      if (this.connectWait) {
        const w = this.connectWait;
        this.connectWait = null;
        clearTimeout(w.timer);
        w.reject(err);
        this.teardown();
        return;
      }
      if (this.unoWait && cmd === this.unoWait.command) {
        const w = this.unoWait;
        this.unoWait = null;
        clearTimeout(w.timer);
        w.reject(err);
        return;
      }
      if (this.saveWait && (cmd === "save" || cmd === ".uno:Save" || cmd === "storage")) {
        const w = this.saveWait;
        this.saveWait = null;
        clearTimeout(w.timer);
        w.reject(err);
        return;
      }
      // Untracked error — ignore (tile/permission noise etc.).
      return;
    }

    // `loaded:` / `status:` — completes connect() once we have a viewid.
    if (text.startsWith("loaded:") || text.startsWith("status:")) {
      const vid = this.parseViewId(text);
      if (this.connectWait && vid !== null) {
        const w = this.connectWait;
        this.connectWait = null;
        clearTimeout(w.timer);
        w.resolve();
      }
      return;
    }

    // `getchildid: id=<id>` — completes a pending `getChildId()`. Wire
    // format grounded at `CanvasTileLayer.js:848-850` (dispatch) +
    // `_onGetChildIdMsg:1611-1613` (`fire('childid', {id: command.id})`,
    // where `command.id` is parsed from the `id=` token by
    // `ServerCommand.ts:97-99`).
    if (text.startsWith("getchildid:")) {
      if (this.childIdWait) {
        const id = this.parseChildId(text);
        const w = this.childIdWait;
        this.childIdWait = null;
        clearTimeout(w.timer);
        w.resolve(id);
      }
      return;
    }

    // `graphicselection: <json-array>|EMPTY` — pushed by coolwsd whenever a
    // graphic is selected / deselected. Wire format grounded at
    // `EXTERNAL/collabora-online-source/browser/src/app/GraphicSelectionMiddleware.ts:328-355`
    // (`textMsg = '[' + textMsg.substr('graphicselection:'.length) + ']'; JSON.parse(textMsg)`
    // → `extractAndSetGraphicSelection(msgData)` constructs
    // `rectangle = new SimpleRectangle(msgData[0], msgData[1], msgData[2],
    // msgData[3])`). Payload `[x1, y1, x2, y2, angle?, extraInfo?]` in twips;
    // `EMPTY` clears the selection.
    if (text.startsWith("graphicselection:")) {
      const rest = text.slice("graphicselection:".length).trim();
      if (rest === "EMPTY" || rest.length === 0) {
        // Kit deselected — clear cache, leave waiters pending (they're
        // waiting for a NON-empty selection; an EMPTY push is not it).
        this.graphicSelectionRect = null;
        return;
      }
      const parsed = this.parseGraphicSelection(rest);
      if (parsed) {
        this.graphicSelectionRect = parsed;
        // Drain all pending waiters with the fresh rect.
        for (const w of this.graphicSelectionWaiters.values()) {
          clearTimeout(w.timer);
          w.resolve(parsed);
        }
        this.graphicSelectionWaiters.clear();
      }
      // Malformed payload — leave cache + waiters untouched (a later,
      // well-formed push will resolve them).
      return;
    }

    // `unocommandresult: <json>` — completes a pending sendUnoAndWait AND
    // a pending save() when the result is for `.uno:Save`.
    if (text.startsWith("unocommandresult:")) {
      const payload = this.parseUnoResult(text);
      const cmdName =
        typeof payload === "object" && payload !== null && "commandName" in payload
          ? String((payload as { commandName: unknown }).commandName)
          : null;
      if (this.unoWait && (cmdName === this.unoWait.command || cmdName === `uno:${this.unoWait.command}`)) {
        const w = this.unoWait;
        this.unoWait = null;
        clearTimeout(w.timer);
        w.resolve(payload);
      }
      if (this.saveWait && (cmdName === ".uno:Save" || cmdName === "uno:.uno:Save")) {
        const w = this.saveWait;
        this.saveWait = null;
        clearTimeout(w.timer);
        w.resolve();
      }
      return;
    }

    // `.uno:ExecuteSearch` does NOT ack via `unocommandresult:`. The engine
    // replies `searchresultselection:` (match found + replaced/selected) or
    // `searchnotfound:` (no match). Complete a pending ExecuteSearch wait on
    // either (verified live 2026-07-03 — the earlier "timed out" bug).
    if (
      this.unoWait &&
      this.unoWait.command === ".uno:ExecuteSearch" &&
      (text.startsWith("searchresultselection:") || text.startsWith("searchnotfound:"))
    ) {
      const w = this.unoWait;
      this.unoWait = null;
      clearTimeout(w.timer);
      if (text.startsWith("searchnotfound:")) {
        w.reject(new Error("cool-session: search string not found"));
      } else {
        w.resolve({ commandName: ".uno:ExecuteSearch", searchResult: text });
      }
      return;
    }

    // `statechanged: <json-or-key=value>` — ADDITIVE: cache the state for
    // EVERY command (so `getCommandState` can read it), then run the
    // existing save-tolerant ModifiedStatus→save path unchanged. Wire
    // format grounded at
    // `EXTERNAL/collabora-online-source/wsd/protocol.txt:658-661`
    // (`statechanged: <key>=<value>`) and the JSON form at
    // `EXTERNAL/collabora-online-source/browser/src/layer/tile/CanvasTileLayer.js:2102-2130`.
    if (text.startsWith("statechanged:")) {
      const rest = text.slice("statechanged:".length).trim();
      const parsed = this.parseCommandState(rest);
      if (parsed) {
        const key = this.normalizeCommandName(parsed.commandName);
        const value = this.normalizeStateValue(parsed.state);
        this.commandStateCache.set(key, value);
        const waiters = this.commandStateWaiters.get(key);
        if (waiters && waiters.length > 0) {
          this.commandStateWaiters.delete(key);
          for (const w of waiters) {
            clearTimeout(w.timer);
            w.resolve(value);
          }
        }
      }
      // Existing save-tolerant signal: when the engine clears
      // `.uno:ModifiedStatus` (state false), treat save() as succeeded.
      if (rest.includes(".uno:ModifiedStatus")) {
        const isFalse = / ModifiedStatus\b.*=false\b/.test(rest) ||
          /"state"\s*:\s*false/.test(rest) ||
          /=false\b/.test(rest);
        if (isFalse && this.saveWait) {
          const w = this.saveWait;
          this.saveWait = null;
          clearTimeout(w.timer);
          w.resolve();
        }
      }
      return;
    }

    // `coolserver ` / `progress: ` / `commandresult: ` / tile traffic etc.
    // — not load-bearing for the agent edit flow; ignore.
  }

  private parseViewId(text: string): number | null {
    const m = text.match(/viewid=(\d+)/);
    return m ? Number(m[1]!) : null;
  }

  /**
   * Parse the `id=` token from a `getchildid:` reply line. Mirrors
   * `ServerCommand.ts:97-99` (`id=` substring extraction, stripping any
   * trailing newline). Returns null if no `id=` token is present (the
   * caller treats null as a hard failure — image insert is not retryable
   * without a childid).
   */
  private parseChildId(text: string): string | null {
    const m = text.match(/\bid=([^\s]+)/);
    if (!m || !m[1]) return null;
    return m[1].replace(/(\r\n|\n|\r)/g, "");
  }

  /**
   * Parse the payload after `graphicselection:` into `{x1, y1, x2, y2}` in
   * twips. Mirrors `GraphicSelectionMiddleware.ts:350-355`: wrap the rest in
   * `[...]` and `JSON.parse` to get `[x1, y1, x2, y2, angle?, extraInfo?]`.
   * Returns null if the array is missing any of the first 4 numeric coords
   * (the caller treats null as "no rect" — waiters stay pending for a
   * later well-formed push).
   */
  private parseGraphicSelection(rest: string): { x1: number; y1: number; x2: number; y2: number } | null {
    const wrapped = "[" + rest + "]";
    try {
      const arr = JSON.parse(wrapped) as unknown;
      if (!Array.isArray(arr) || arr.length < 4) return null;
      const [x1, y1, x2, y2] = arr as unknown[];
      if (
        typeof x1 !== "number" || typeof y1 !== "number" ||
        typeof x2 !== "number" || typeof y2 !== "number"
      ) {
        return null;
      }
      return { x1, y1, x2, y2 };
    } catch {
      return null;
    }
  }

  private parseErrorCommand(text: string): string {
    const m = text.match(/cmd=([^\s]+)/);
    return m ? m[1]! : "";
  }

  /**
   * Normalize a UNO command name to the `.uno:Name` form (the wire always
   * carries the `.uno:` prefix, so cache keys match regardless of whether
   * the caller passed `.uno:TrackChanges` or `TrackChanges`). Mirrors
   * `Map.StateChanges.js:170-175` `ensureUnoCommandPrefix`.
   */
  private normalizeCommandName(command: string): string {
    return command.startsWith(".uno:") ? command : `.uno:${command}`;
  }

  /**
   * Parse the payload after `statechanged:` into `{commandName, state}`.
   * Accepts BOTH wire forms grounded at
   * `EXTERNAL/collabora-online-source/browser/src/layer/tile/CanvasTileLayer.js:2102-2130`:
   *   - JSON: `{"commandName":".uno:Foo","state":"true"}` (state may be
   *     any JSON value; we stringify non-strings for the cache).
   *   - key=value: `.uno:Foo=enabled` (split on FIRST `=` so values may
   *     contain `=`).
   * Returns null if neither form parses to a usable command name.
   */
  private parseCommandState(rest: string): { commandName: string; state: string } | null {
    const trimmed = rest.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const obj = JSON.parse(trimmed) as { commandName?: unknown; state?: unknown };
        if (typeof obj.commandName === "string" && obj.state !== undefined) {
          const state =
            typeof obj.state === "string" ? obj.state : JSON.stringify(obj.state);
          return { commandName: obj.commandName, state };
        }
      } catch {
        // fall through to key=value attempt
      }
      return null;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) return null;
    const commandName = trimmed.slice(0, eq).trim();
    const state = trimmed.slice(eq + 1).trim();
    if (!commandName) return null;
    return { commandName, state };
  }

  /**
   * Normalize a wire state string for the cache: `"true"`/`"false"` →
   * boolean (the common toggle shape, e.g. `.uno:TrackChanges`), other
   * strings kept as-is (`"enabled"`, `"disabled"`, numeric strings, JSON
   * object strings). Matches the boolean-coercion the agent path needs
   * for idempotent sets; non-boolean states remain opaque strings the
   * caller can interpret.
   */
  private normalizeStateValue(state: string): string | boolean {
    if (state === "true") return true;
    if (state === "false") return false;
    return state;
  }

  /** Parse the JSON payload after `unocommandresult:`. Tolerant on failure. */
  private parseUnoResult(text: string): unknown {
    const rest = text.slice("unocommandresult:".length).trim();
    try {
      return JSON.parse(rest);
    } catch {
      return null;
    }
  }
}
