/**
 * Last-resort relay registration `userId` when env + HTTP bootstrap all
 * fail. Matches historical OSS VM scripts (`NAUTILO_USER_ID` in
 * systemd) and `apps/desktop` `LEGACY_RELAY_USER_FALLBACK` — keep in
 * one place (M071 / M072 consolidation).
 */
export const LEGACY_RELAY_USER_FALLBACK = "@owner@nautilo.local";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;
export const RECONNECT_BASE_DELAY_MS = 2_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const DISPATCH_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Private WebSocket close code used only when a relay credential is missing,
 * invalid, or revoked. Retrying the same immutable credential cannot recover,
 * so clients must require an explicit re-pair instead of reconnecting.
 */
export const RELAY_TOKEN_AUTH_CLOSE_CODE = 4401;

/** Additive `relay:error` code sent before the matching 4401 close. */
export const RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE = "authentication_required";

/** D453 relay v8 is a JSON control/event transport, never a file bridge. */
export const CODEX_RELAY_MAX_FRAME_BYTES = 256 * 1024;
/** A relay session deliberately retains only a small amount of Codex replay state. */
export const CODEX_RELAY_REPLAY_CACHE_TTL_MS = 15 * 60 * 1000;
export const CODEX_RELAY_MAX_REPLAY_ENTRIES = 1_024;

/**
 * M174 — ceiling on `readFile` / `writeFileAtomic` payloads proxied over
 * the relay `fs` execution class. Bytes ride base64-over-WS, so the
 * effective wire cost is ~1.34×; keep it bounded. Reads/writes past this
 * return a clear `EFBIG`-style error rather than flooding the socket.
 */
export const RELAY_FS_MAX_BYTES = 16 * 1024 * 1024;

/**
 * M216 — Writer live-review document transport above the generic 16 MiB
 * `file.read` cap and up to Writer's 50 MiB container limit. Applies only
 * to typed `kind:"document"` local-file operations, not generic `file.read`.
 */
export const RELAY_LOCAL_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
/** Ordered document chunks over relay WebSocket (base64 wire cost ~1.34×). */
export const RELAY_LOCAL_DOCUMENT_CHUNK_BYTES = 1024 * 1024;
export const RELAY_LOCAL_DOCUMENT_TRANSFER_TTL_MS = 5 * 60 * 1000;

/**
 * M206 — machine-readable error when a relay receives a `local-file`
 * dispatch it cannot execute (headless relay, or pre-v4 profile).
 */
export const LOCAL_FILE_EXECUTION_UNSUPPORTED = "LOCAL_FILE_EXECUTION_UNSUPPORTED";
