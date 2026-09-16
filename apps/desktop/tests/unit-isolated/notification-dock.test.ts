import { describe, expect, mock, test } from "bun:test";
import {
  applyDockAttention,
  clearDockAttention,
  validateDockAttentionInput,
  type DockAttentionDeps,
} from "../../electron/notification-dock";

function deps(
  overrides: Partial<DockAttentionDeps> = {},
): DockAttentionDeps {
  return {
    platform: () => "darwin",
    setNumericBadge: () => true,
    setTextBadge: () => {},
    ...overrides,
  };
}

describe("M239 Dock attention projection", () => {
  test("maps clear, dot, exact count, and 99+ states", () => {
    expect(validateDockAttentionInput({ kind: "clear" })).toEqual({
      kind: "clear",
    });
    expect(
      validateDockAttentionInput({
        kind: "counts",
        unreadCount: 4,
        importantUnreadCount: 0,
      }),
    ).toEqual({ kind: "dot" });
    expect(
      validateDockAttentionInput({
        kind: "counts",
        unreadCount: 99,
        importantUnreadCount: 99,
      }),
    ).toEqual({ kind: "count", count: 99 });
    expect(
      validateDockAttentionInput({
        kind: "counts",
        unreadCount: 101,
        importantUnreadCount: 100,
      }),
    ).toEqual({ kind: "text", text: "99+" });
  });

  test("rejects partial, impossible, unsafe, and extra-field payloads", () => {
    expect(
      validateDockAttentionInput({
        kind: "counts",
        unreadCount: 1,
        importantUnreadCount: 2,
      }),
    ).toBeNull();
    expect(
      validateDockAttentionInput({
        kind: "counts",
        unreadCount: -1,
        importantUnreadCount: 0,
      }),
    ).toBeNull();
    expect(
      validateDockAttentionInput({
        kind: "counts",
        unreadCount: Number.MAX_SAFE_INTEGER + 1,
        importantUnreadCount: 0,
      }),
    ).toBeNull();
    expect(
      validateDockAttentionInput({
        kind: "clear",
        unreadCount: 0,
      } as never),
    ).toBeNull();
  });

  test("uses the exact native API for each display state", () => {
    const setNumericBadge = mock((_count?: number) => true);
    const setTextBadge = mock((_text: string) => {});
    const policy = deps({ setNumericBadge, setTextBadge });

    expect(
      applyDockAttention(
        {
          kind: "counts",
          unreadCount: 2,
          importantUnreadCount: 0,
        },
        policy,
      ),
    ).toEqual({ ok: true });
    expect(setNumericBadge).toHaveBeenLastCalledWith();

    expect(
      applyDockAttention(
        {
          kind: "counts",
          unreadCount: 2,
          importantUnreadCount: 2,
        },
        policy,
      ),
    ).toEqual({ ok: true });
    expect(setNumericBadge).toHaveBeenLastCalledWith(2);

    expect(
      applyDockAttention(
        {
          kind: "counts",
          unreadCount: 120,
          importantUnreadCount: 120,
        },
        policy,
      ),
    ).toEqual({ ok: true });
    expect(setTextBadge).toHaveBeenLastCalledWith("99+");

    expect(applyDockAttention({ kind: "clear" }, policy)).toEqual({
      ok: true,
    });
    expect(setTextBadge).toHaveBeenLastCalledWith("");
  });

  test("isolates native and platform failure", () => {
    expect(
      applyDockAttention(
        { kind: "clear" },
        deps({ platform: () => "linux" }),
      ),
    ).toEqual({ ok: false, reason: "unsupported-platform" });
    expect(
      applyDockAttention(
        {
          kind: "counts",
          unreadCount: 1,
          importantUnreadCount: 0,
        },
        deps({ setNumericBadge: () => false }),
      ),
    ).toEqual({ ok: false, reason: "native-failed" });
    expect(
      clearDockAttention(
        deps({
          setTextBadge: () => {
            throw new Error("no dock");
          },
        }),
      ),
    ).toBe(false);
  });
});
