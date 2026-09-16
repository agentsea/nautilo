/**
 * M240 — pure registry-owned macOS Dock attention policy.
 */

export type DockAttentionInput =
  | { kind: "clear" }
  | {
      kind: "counts";
      unreadCount: unknown;
      importantUnreadCount: unknown;
    };

export type DockAttentionState =
  | { kind: "clear" }
  | { kind: "dot" }
  | { kind: "count"; count: number }
  | { kind: "text"; text: "99+" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function validateDockAttentionInput(
  input: DockAttentionInput,
): DockAttentionState | null {
  if (!isPlainObject(input) || typeof input.kind !== "string") return null;
  if (input.kind === "clear") {
    return Object.keys(input).length === 1 ? { kind: "clear" } : null;
  }
  if (
    input.kind !== "counts" ||
    Object.keys(input).some(
      (key) =>
        key !== "kind" &&
        key !== "unreadCount" &&
        key !== "importantUnreadCount",
    ) ||
    !isCount(input.unreadCount) ||
    !isCount(input.importantUnreadCount) ||
    input.importantUnreadCount > input.unreadCount
  ) {
    return null;
  }
  if (input.unreadCount === 0) return { kind: "clear" };
  if (input.importantUnreadCount === 0) return { kind: "dot" };
  if (input.importantUnreadCount <= 99) {
    return { kind: "count", count: input.importantUnreadCount };
  }
  return { kind: "text", text: "99+" };
}

export type SetDockAttentionResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid-payload"
        | "unsupported-platform"
        | "native-failed";
    };

export interface DockAttentionDeps {
  platform(): string;
  /** `app.setBadgeCount(count?)`; omitted count produces the macOS dot. */
  setNumericBadge(count?: number): boolean;
  /** `app.dock.setBadge(text)`; required for the exact `99+` state. */
  setTextBadge(text: string): void;
}

export function clearDockAttention(
  deps: Pick<DockAttentionDeps, "platform" | "setTextBadge">,
): boolean {
  if (deps.platform() !== "darwin") return false;
  try {
    deps.setTextBadge("");
    return true;
  } catch {
    return false;
  }
}

/** M240 — apply registry-owned aggregate state without renderer authority. */
export function applyDockAttention(
  input: DockAttentionInput,
  deps: DockAttentionDeps,
): SetDockAttentionResult {
  const state = validateDockAttentionInput(input);
  if (!state) return { ok: false, reason: "invalid-payload" };
  if (deps.platform() !== "darwin") {
    return { ok: false, reason: "unsupported-platform" };
  }
  try {
    switch (state.kind) {
      case "clear":
        deps.setTextBadge("");
        break;
      case "dot":
        if (!deps.setNumericBadge()) {
          return { ok: false, reason: "native-failed" };
        }
        break;
      case "count":
        if (!deps.setNumericBadge(state.count)) {
          return { ok: false, reason: "native-failed" };
        }
        break;
      case "text":
        deps.setTextBadge(state.text);
        break;
    }
  } catch {
    return { ok: false, reason: "native-failed" };
  }
  return { ok: true };
}
