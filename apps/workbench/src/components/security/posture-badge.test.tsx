import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type UncontainedStatus = {
  confirmed: boolean;
  active: boolean;
  eligible: boolean;
  reason: string | null;
  activatedAt: string | null;
};

const posture = {
  deploymentMode: "desktop-permissive" as const,
  securityLevel: "standard" as const,
  allowUncontainedHostCommands: true,
  networkPolicy: { mode: "host" as const },
  capabilities: [],
  actorRole: "superuser",
  writablePaths: [],
  readOnlyPaths: [],
  backend: { kind: "sandbox-exec" as const },
};

let status: UncontainedStatus = {
  confirmed: true,
  active: false,
  eligible: true,
  reason: null,
  activatedAt: null,
};

const getStatus = mock(async () => status);
const activate = mock(async () => ({ ok: true as const }));
const disable = mock(async () => ({ ok: true as const }));

mock.module("../../contexts/posture-context", () => ({
  usePosture: () => ({ posture, loading: false, error: null, refresh: async () => undefined }),
  canManageServerSecurity: () => false,
}));
mock.module("../../hooks/use-can", () => ({
  useCan: () => (capability: string) =>
    capability === "read_server_settings" || capability === "use_workstation",
}));
mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { role: "superuser" } }),
}));
mock.module("../../adapters/runtime-contexts", () => ({
  useAutoApprove: () => ({ enabled: false }),
}));
mock.module("../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    uncontainedHostCommands: { getStatus, activate, disable },
  },
}));
mock.module("./posture-edit-modal", () => ({
  PostureEditModal: () => null,
}));

const { PostureBadge } = await import("./posture-badge");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  status = {
    confirmed: true,
    active: false,
    eligible: true,
    reason: null,
    activatedAt: null,
  };
  getStatus.mockClear();
  activate.mockClear();
  disable.mockClear();
});

afterAll(() => {
  cleanup();
  mock.restore();
});

describe("PostureBadge Direct Mac execution", () => {
  test("uses the existing Security badge as the sole confirmed active indicator and off entry", async () => {
    status = {
      confirmed: true,
      active: true,
      eligible: true,
      reason: null,
      activatedAt: "2026-08-26T12:00:00.000Z",
    };
    disable.mockImplementation(async () => {
      status = { ...status, active: false, activatedAt: null };
      return { ok: true as const };
    });

    const view = render(<PostureBadge />);
    const badge = await waitFor(() =>
      view.getByRole("button", { name: /SECURITY: UNCONTAINED/i }),
    );
    fireEvent.click(badge);
    await waitFor(() => {
      expect(view.getByRole("heading", { name: "THIS DESKTOP IS UNCONTAINED" })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Turn off immediately" }));
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(view.queryByRole("button", { name: /SECURITY: UNCONTAINED/i })).toBeNull();
      expect(view.getByRole("button", { name: /Security: Standard/i })).toBeTruthy();
    });
  });

  test("never echoes an unconfirmed active response as uncontained", async () => {
    status = {
      confirmed: false,
      active: true,
      eligible: true,
      reason: "server_status_refreshing",
      activatedAt: "2026-08-26T12:00:00.000Z",
    };

    const view = render(<PostureBadge />);
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("button", { name: /SECURITY: UNCONTAINED/i })).toBeNull();
    expect(view.getByRole("button", { name: /Security: Standard/i })).toBeTruthy();
  });

  test("refreshes eligibility whenever Security opens", async () => {
    status = {
      confirmed: true,
      active: false,
      eligible: false,
      reason: "grant_missing",
      activatedAt: null,
    };
    const view = render(<PostureBadge />);
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));

    status = { ...status, eligible: true, reason: null };
    fireEvent.click(view.getByRole("button", { name: /Security: Standard/i }));

    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(view.getByRole("button", { name: "Enable for this session" })).toBeTruthy();
    });
  });

  test("clears confirmed authority before lifecycle revalidation completes", async () => {
    status = {
      confirmed: true,
      active: true,
      eligible: true,
      reason: null,
      activatedAt: "2026-08-26T12:00:00.000Z",
    };
    const view = render(<PostureBadge />);
    await waitFor(() => expect(view.getByRole("button", { name: /SECURITY: UNCONTAINED/i })).toBeTruthy());

    let release: ((next: UncontainedStatus) => void) | null = null;
    getStatus.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    act(() => window.dispatchEvent(new Event("nautilo:policy-changed")));
    await waitFor(() => {
      expect(view.queryByRole("button", { name: /SECURITY: UNCONTAINED/i })).toBeNull();
    });
    act(() => release?.(status));
    await waitFor(() => expect(view.getByRole("button", { name: /SECURITY: UNCONTAINED/i })).toBeTruthy());
  });
});
