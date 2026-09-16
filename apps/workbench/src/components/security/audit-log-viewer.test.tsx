/**
 * D220 Phase 2 — AuditLogViewer filters + load-more.
 */
import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { SecurityAuditEvent } from "@nautilo/api-client/browser";
import type { CapabilitySlug } from "@nautilo/types";

const realUseCan = await import("../../hooks/use-can");

let mockCaps: CapabilitySlug[] = ["view_audit_log"];

mock.module("../../hooks/use-can", () => ({
  useCan: () => (cap: CapabilitySlug) => mockCaps.includes(cap),
}));

const getSecurityAuditLog = mock(
  async (_opts?: {
    limit?: number;
    since?: string;
    actorId?: string;
    kinds?: readonly string[];
  }) => ({
    events: [] as readonly SecurityAuditEvent[],
    hasMore: false,
  }),
);

mock.module("../../lib/api", () => ({
  apiClient: {
    getSecurityAuditLog,
  },
}));

const { AuditLogViewer } = await import("./audit-log-viewer");

afterAll(() => {
  mock.module("../../hooks/use-can", () => realUseCan);
});

const sampleEvent = (
  overrides: Partial<SecurityAuditEvent> & Pick<SecurityAuditEvent, "kind" | "ts">,
): SecurityAuditEvent => ({
  actorId: "actor-1",
  ...overrides,
});

function recentTs(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  mockCaps = ["view_audit_log"];
  getSecurityAuditLog.mockReset();
  getSecurityAuditLog.mockImplementation(async () => ({
    events: [],
    hasMore: false,
  }));
});

describe("AuditLogViewer", () => {
  test("renders events from a mocked response", async () => {
    getSecurityAuditLog.mockImplementation(async () => ({
      events: [
        sampleEvent({
          kind: "user_disabled",
          ts: recentTs(1),
          targetUserId: "user-99",
          reason: "policy",
        }),
        sampleEvent({
          kind: "posture_changed",
          ts: recentTs(2),
          prev: { deploymentMode: "server", securityLevel: "cautious" },
          next: { deploymentMode: "server", securityLevel: "paranoid" },
        }),
      ],
      hasMore: false,
    }));

    const view = render(<AuditLogViewer />);

    await waitFor(() => {
      expect(view.getByText("user_disabled")).toBeTruthy();
    });

    expect(view.getByText(/Posture/)).toBeTruthy();
    expect(view.getByText(/Disabled user/)).toBeTruthy();
    expect(view.getByText(/user-99/)).toBeTruthy();
    expect(view.getByTestId("audit-log-count").textContent).toContain("Showing 2 events");
  });

  test("changing the kind filter re-queries with kinds", async () => {
    getSecurityAuditLog.mockImplementation(async () => ({
      events: [sampleEvent({ kind: "invite_minted", ts: recentTs(1), inviteId: "inv-1", inviteKind: "server" })],
      hasMore: false,
    }));

    const view = render(<AuditLogViewer />);

    await waitFor(() => {
      expect(getSecurityAuditLog).toHaveBeenCalled();
    });

    getSecurityAuditLog.mockClear();

    const postureCheckbox = view.getByTestId("audit-log-kind-posture_changed") as HTMLInputElement;
    fireEvent.click(postureCheckbox);

    await waitFor(() => {
      expect(getSecurityAuditLog).toHaveBeenCalled();
    });

    const lastCall = getSecurityAuditLog.mock.calls.at(-1)?.[0];
    expect(lastCall?.kinds).toBeDefined();
    expect(lastCall?.kinds).not.toContain("posture_changed");
    expect(lastCall?.kinds).toContain("invite_minted");
  });

  test("load-more requests older rows via since", async () => {
    getSecurityAuditLog
      .mockImplementationOnce(async (opts) => {
        expect(opts?.since).toBeDefined();
        expect(typeof opts?.since).toBe("string");
        expect(opts?.limit).toBe(50);
        return {
          events: [
            sampleEvent({ kind: "approval_granted", ts: recentTs(1) }),
          ],
          hasMore: true,
        };
      })
      .mockImplementationOnce(async (opts) => {
        expect(opts?.since).toBeDefined();
        expect(typeof opts?.since).toBe("string");
        expect(opts!.limit!).toBeGreaterThan(50);
        return {
          events: [
            sampleEvent({ kind: "approval_granted", ts: recentTs(1) }),
            sampleEvent({ kind: "approval_denied", ts: recentTs(3) }),
          ],
          hasMore: false,
        };
      });

    const view = render(<AuditLogViewer />);

    await waitFor(() => {
      expect(view.getByText("approval_granted")).toBeTruthy();
    });

    expect(view.getByTestId("audit-log-load-more")).toBeTruthy();
    fireEvent.click(view.getByTestId("audit-log-load-more"));

    await waitFor(() => {
      expect(view.getByText("approval_denied")).toBeTruthy();
    });

    expect(getSecurityAuditLog).toHaveBeenCalledTimes(2);
    expect(view.getByTestId("audit-log-count").textContent).toContain("Showing 2 events");
  });

  test("returns null when the viewer lacks view_audit_log", () => {
    mockCaps = [];
    const view = render(<AuditLogViewer />);
    expect(view.queryByTestId("audit-log-viewer")).toBeNull();
  });
});
