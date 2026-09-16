// Pure helper consumed by auth-window.ts (and the unit test).

import { ELECTRON_PRE_AUTH_INLINE_COLORS } from "./pre-auth-inline-css";

export type LoadFailureKind = "logto-unreachable" | "logto-error" | "other";

export interface FriendlyPageInput {
  logtoEndpoint: string;
  retryUrl: string;
}

const LOGTO_UNREACHABLE_CODES = new Set([
  -2, -7, -21, -100, -101, -102, -105, -118, -130,
]);

/**
 * Maps Chromium net / Electron `did-fail-load` codes to a coarse recovery
 * bucket. `-3` (ABORTED) is `"other"` so the auth-window listener can
 * suppress false positives during navigation replacement.
 */
export function classifyAuthWindowLoadFailure(
  errorCode: number,
  errorDescription: string,
): LoadFailureKind {
  void errorDescription;
  if (errorCode === -3) return "other";
  if (LOGTO_UNREACHABLE_CODES.has(errorCode)) return "logto-unreachable";
  if (errorCode <= -200 && errorCode >= -299) return "logto-error";
  return "other";
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Stack 19 Phase 6.9.2 (2026-05-17) — http/https-only URL allowlist.
 * Mirrors the `safeHttpUrl` validator in `cold-boot-picker.html`. Used
 * to gate `retryUrl` before it flows into `window.location.href`.
 * Returns the canonicalized URL string on success, null on parse
 * failure or non-http(s) protocol (e.g. `javascript:`, `data:`,
 * `file:`).
 */
export function safeHttpRetryUrl(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Full document HTML for `data:text/html;charset=utf-8` load. Styles consume
 * the D254 Electron pre-auth inline token helper; the static cold boot picker
 * still has its legacy hardcoded palette until it gets a generator/TS-rendered
 * path in a later slice.
 *
 * Stack 19 Phase 6.9.2 HIGH XSS hardening (2026-05-17): pre-fix the
 * Retry button used `onclick="window.location.href=${JSON.stringify(retryUrl)}"`
 * with the JSON literal interpolated INSIDE a double-quoted HTML
 * attribute. JSON strings contain `"` (URL query-encoding) → attribute
 * shape breaks for any URL with query params → Retry silently broken
 * on normal inputs. Hostile URLs were also attribute/JS-injection
 * surface, AND a `javascript:` URL assigned to `window.location.href`
 * would execute in the privileged auth-window context.
 *
 * Reviewer's BLOCK High-#2 finding on PR #188 (2026-05-16T17:30Z).
 *
 * Fix shape:
 *   - Drop inline `onclick="..."`. Use a `<script>` block with
 *     `addEventListener('click', ...)` per button (mirrors the
 *     Phase 6.9.1 cold-boot-picker fix).
 *   - URL stored on the button via a `data-retry-url` attribute
 *     (escapeHtml'd into the source so HTML parsing stays clean).
 *   - URL validated via `safeHttpRetryUrl()` at click-time — if it
 *     parses cleanly AND is http/https, navigate; otherwise no-op +
 *     log. The validator is exported for the regression test.
 *   - Sibling buttons ("Pick a different server", "Cancel") have
 *     STATIC click handlers (no user data); they still use
 *     addEventListener for consistency.
 *
 * Pinned by `apps/desktop/tests/unit/logto-unreachable-friendly-page.test.ts`.
 */
export function renderLogtoUnreachablePageHtml(input: FriendlyPageInput): string {
  const logtoEndpoint = escapeHtml(input.logtoEndpoint);
  // escapeHtml on retryUrl is sufficient for safe attribute insertion
  // (quotes become &quot;); the click handler re-validates via
  // safeHttpRetryUrl before navigation. Belt-and-suspenders.
  const retryUrlAttr = escapeHtml(input.retryUrl);
  const colors = ELECTRON_PRE_AUTH_INLINE_COLORS;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nautilo</title>
    <style>
      html,
      body {
        height: 100%;
        margin: 0;
        font-family: Inter, system-ui, sans-serif;
        background: ${colors.background};
        color: ${colors.foreground};
      }
      .shell {
        min-height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px 20px;
        box-sizing: border-box;
      }
      .card {
        max-width: 440px;
        width: 100%;
        text-align: center;
      }
      .wordmark {
        font-size: 1.5rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        margin-bottom: 28px;
        color: ${colors.foreground};
      }
      h1 {
        font-size: 1.25rem;
        font-weight: 600;
        margin: 0 0 10px;
      }
      .sub {
        font-size: 0.95rem;
        line-height: 1.45;
        color: ${colors.foregroundMuted};
        margin: 0 0 24px;
      }
      .actions {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      button.cta {
        cursor: pointer;
        border: none;
        border-radius: 8px;
        padding: 10px 16px;
        font-size: 0.95rem;
        font-weight: 600;
        font-family: inherit;
        background: ${colors.primary};
        color: ${colors.onPrimary};
      }
      button.cta:hover {
        filter: brightness(1.06);
      }
      button.secondary {
        cursor: pointer;
        border: 1px solid ${colors.borderSubtle};
        border-radius: 8px;
        padding: 10px 16px;
        font-size: 0.95rem;
        font-weight: 500;
        font-family: inherit;
        background: transparent;
        color: ${colors.foreground};
      }
      button.secondary:hover {
        background: ${colors.hoverSubtle};
      }
      button.tertiary {
        cursor: pointer;
        border: none;
        border-radius: 8px;
        padding: 8px 16px;
        font-size: 0.9rem;
        font-weight: 500;
        font-family: inherit;
        background: transparent;
        color: ${colors.foregroundDim};
      }
      button.tertiary:hover {
        color: ${colors.foregroundMuted};
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.82rem;
        word-break: break-all;
        color: ${colors.mono};
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card">
        <div class="wordmark">Nautilo</div>
        <h1>Sign-in service unreachable</h1>
        <p class="sub">Sign-in service unreachable at <span class="mono">${logtoEndpoint}</span>. The server you're paired with may be temporarily down or misconfigured. You can retry, pick a different server, or quit and try again later.</p>
        <div class="actions">
          <button type="button" class="cta" id="nautilo-retry" data-retry-url="${retryUrlAttr}">Retry</button>
          <button type="button" class="secondary" id="nautilo-pair-different">Pick a different server</button>
          <button type="button" class="tertiary" id="nautilo-cancel">Cancel</button>
        </div>
      </div>
    </div>
    <script>
      // Phase 6.9.2 — no inline onclick attributes. Each button has a
      // static id; the script wires click handlers via
      // addEventListener. URL validation re-runs at click-time as
      // belt-and-suspenders even though the URL was escapeHtml'd into
      // the attribute server-side.
      //
      // Note: this inline safeHttpRetryUrl is a SEPARATE definition
      // from the TS-exported one above — they run in different
      // contexts (the TS one in the main process for tests; this one
      // in the data: URL's renderer). They MUST stay in sync. If you
      // tighten the protocol allowlist or add scheme handling, update
      // BOTH and update the regression test that pins the contract
      // on the exported version.
      (function () {
        function safeHttpRetryUrl(raw) {
          if (typeof raw !== "string" || raw.length === 0) return null;
          try {
            var u = new URL(raw);
            if (u.protocol !== "http:" && u.protocol !== "https:") return null;
            return u.toString();
          } catch (_e) {
            return null;
          }
        }
        var retryBtn = document.getElementById("nautilo-retry");
        if (retryBtn) {
          retryBtn.addEventListener("click", function () {
            var url = safeHttpRetryUrl(retryBtn.getAttribute("data-retry-url") || "");
            if (url) window.location.href = url;
          });
        }
        var pairBtn = document.getElementById("nautilo-pair-different");
        if (pairBtn) {
          pairBtn.addEventListener("click", function () {
            window.location.href = "about:blank#nautilo-pair-different";
            setTimeout(function () { window.close(); }, 0);
          });
        }
        var cancelBtn = document.getElementById("nautilo-cancel");
        if (cancelBtn) {
          cancelBtn.addEventListener("click", function () { window.close(); });
        }
      })();
    </script>
  </body>
</html>`;
}
