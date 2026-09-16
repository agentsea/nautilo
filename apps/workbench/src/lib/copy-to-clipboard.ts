/**
 * Shared clipboard-write helper (ISSUE-D367).
 *
 * Before this, every copy site in workbench inlined its own
 * `navigator.clipboard.writeText` + `document.execCommand("copy")`
 * fallback (settings/security-section, admin/user-detail-panel,
 * members-section). This is the first shared owner; new copy paths
 * (message "Copy message") should use it. Migrating the existing
 * inline copies onto it is tracked follow-up, not required here.
 *
 * The hidden-textarea fallback matters because embedded WebViews
 * (Electron `<webview>`, the desktop shell) frequently expose no
 * async `navigator.clipboard` or reject its promise.
 */

/** Fallback when `navigator.clipboard` is missing or rejects. */
export function copyTextViaHiddenTextarea(text: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
  }
  return ok;
}

/**
 * Write `text` to the local clipboard. Returns whether the write
 * succeeded. Empty/whitespace-only input is a no-op that returns
 * `false` (there is nothing meaningful to copy).
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      return copyTextViaHiddenTextarea(text);
    }
  }
  return copyTextViaHiddenTextarea(text);
}
