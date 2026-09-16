import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let grants: Array<Record<string, unknown>> = [];
let capabilities = ["use_workstation"];
let shellConsent: "none" | "session" | "durable" = "none";
const list = mock(async () => ({ ok: true as const, data: { grants, revision: 1 } }));
const pick = mock(async () => "/Users/alice/Documents/approved");
const validate = mock(async () => ({
  ok: true as const,
  data: {
    canonicalRoot: "/Users/alice/Documents/approved",
    filesystemIdentity: { realRoot: "/Users/alice/Documents/approved", device: 1, inode: 2 },
  },
}));
const create = mock(async () => ({ ok: true as const, data: { grant: {}, revision: 2 } }));
const revoke = mock(async () => ({ ok: true as const, data: { grant: {}, revision: 2 } }));
const getSeedDescriptor = mock(async () => ({
  ok: true as const,
  data: {
    id: "developer-workstation",
    revision: 4,
    name: "Developer Workstation",
    protectedPolicyVersion: 1,
    networkMode: "host",
    discoveryProviders: ["path"],
    environmentKeys: ["PATH"],
    capabilities: [{ id: "developer_tools", backend: "local_process" }],
  },
}));
const runDiscoveryReview = mock(async () => ({
  ok: true as const,
  data: {
    seedIdentity: { id: "developer-workstation", revision: 4, protectedPolicyVersion: 1 },
    review: {
      generatedAt: "2026-07-13T12:00:00.000Z",
      platform: "darwin",
      home: "/Users/alice",
      networkMode: "host",
      rows: [{ tool: "git", status: "found", note: "Found on PATH" }],
      hostNetworkImplication: "Uses the desktop's available network.",
      hardBoundaries: ["No renderer-provided executable or filesystem rules."],
      summary: { found: 1, optional: 0, missing: 0 },
    },
  },
}));
const listProfiles = mock(async () => ({ ok: true as const, data: { profiles: [], revision: 0 } }));
let activeProfileSummary: null | {
  profileId: string;
  profileRevision: number;
  protectedPolicyVersion: number;
  networkMode: "host";
  capabilities: Array<{ id: string; backend: "local_process" }>;
  compiledAt: string;
} = null;
const getActiveProfileSummary = mock(async () => ({ ok: true as const, data: activeProfileSummary }));
const materializeSeedProfile = mock(async () => ({
  ok: true as const,
  data: {
    created: true,
    revision: 1,
    profile: {
      id: "developer-workstation",
      revision: 4,
      name: "Developer Workstation",
      protectedPolicyVersion: 1,
      networkMode: "host",
      capabilities: [{ id: "developer_tools", backend: "local_process" }],
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T12:00:00.000Z",
    },
  },
}));
const selectActiveProfile = mock(async () => ({
  ok: true as const,
  data: {
    outcome: "activated",
    summary: {
      profileId: "developer-workstation",
      profileRevision: 4,
      protectedPolicyVersion: 1,
      networkMode: "host",
      capabilities: [{ id: "developer_tools", backend: "local_process" }],
      compiledAt: "2026-07-13T12:00:00.000Z",
    },
  },
}));
const deactivateActiveProfile = mock(async () => ({
  ok: true as const,
  data: { cleared: 1, skipped: [] },
}));
const getShellStatus = mock(async () => ({
  workspacePath: "/Users/alice/project",
  consented: shellConsent !== "none",
  consent: shellConsent,
}));
const revokeShell = mock(async () => {
  shellConsent = "none";
});
let uncontainedStatus = {
  confirmed: false,
  active: false,
  eligible: false,
  reason: "server_status_unavailable" as string | null,
  activatedAt: null as string | null,
};
const getUncontainedStatus = mock(async () => uncontainedStatus);
const activateUncontained = mock(async () => ({ ok: true as const }));
const disableUncontained = mock(async () => ({ ok: true as const }));

mock.module("../../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    desktopFilesystemGrants: { list, pick, validate, create, revoke },
    workstationProfiles: {
      getSeedDescriptor,
      runDiscoveryReview,
      listProfiles,
      getActiveProfileSummary,
      materializeSeedProfile,
      selectActiveProfile,
      deactivateActiveProfile,
    },
    workstationShell: {
      status: getShellStatus,
      revoke: revokeShell,
    },
    uncontainedHostCommands: {
      getStatus: getUncontainedStatus,
      activate: activateUncontained,
      disable: disableUncontained,
    },
  },
}));

mock.module("../../../components/pin-dialog", () => ({
  PinDialog: ({ onSubmit }: { onSubmit: (pin: string) => void }) => (
    <button onClick={() => onSubmit("123456")} aria-label="Submit test PIN">
      Submit test PIN
    </button>
  ),
}));

mock.module("../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionUserId: "user-1" } }),
}));

mock.module("../../../hooks/use-can", () => ({
  useCan: () => (capability: string) => capabilities.includes(capability),
}));

const { DesktopFilesystemAccessSection } = await import("./workstation-access-section");
const { publishWorkstationProfileChanged } = await import("../../../lib/workstation-profile-events");

function activeGrant(id = "grant-1") {
  return {
    status: "active",
    grant: {
      schemaVersion: 1,
      id,
      canonicalRoot: "/Users/alice/Documents/approved",
      access: ["read", "create_modify"],
      origin: "user_picker",
      lifetime: "durable",
      subject: {
        userId: "user-1",
        instanceId: "instance-1",
        relayId: "relay-1",
        agentScope: "all_owned_agents",
      },
      createdBy: "user-1",
      createdAt: "2026-07-12T12:00:00.000Z",
      policyVersion: 1,
      lastUsedAt: "2026-07-12T12:30:00.000Z",
      filesystemIdentity: {
        realRoot: "/Users/alice/Documents/approved",
        device: 1,
        inode: 2,
      },
    },
  };
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  grants = [];
  capabilities = ["use_workstation"];
  shellConsent = "none";
  activeProfileSummary = null;
  window.localStorage.clear();
  list.mockClear();
  pick.mockClear();
  validate.mockClear();
  create.mockClear();
  revoke.mockClear();
  getSeedDescriptor.mockClear();
  runDiscoveryReview.mockClear();
  listProfiles.mockClear();
  listProfiles.mockImplementation(async () => ({ ok: true as const, data: { profiles: [], revision: 0 } }));
  getActiveProfileSummary.mockClear();
  materializeSeedProfile.mockClear();
  selectActiveProfile.mockClear();
  deactivateActiveProfile.mockClear();
  uncontainedStatus = {
    confirmed: false,
    active: false,
    eligible: false,
    reason: "server_status_unavailable",
    activatedAt: null,
  };
  getUncontainedStatus.mockClear();
  activateUncontained.mockClear();
  disableUncontained.mockClear();
  getShellStatus.mockClear();
  revokeShell.mockClear();
});

afterAll(() => {
  mock.restore();
});

describe("DesktopFilesystemAccessSection", () => {
  test("never represents uncontained host commands as on without server confirmation", async () => {
    uncontainedStatus = {
      confirmed: false,
      active: true,
      eligible: true,
      reason: null,
      activatedAt: "2026-08-17T12:00:00.000Z",
    };
    const view = render(<DesktopFilesystemAccessSection />);
    expect(await view.findByText("Uncontained host commands")).toBeTruthy();
    expect(view.getByText("Unavailable")).toBeTruthy();
    expect(view.queryByText("On this session")).toBeNull();
  });

  test("shows the warning, activates with only an own PIN, and disables immediately", async () => {
    uncontainedStatus = {
      confirmed: true,
      active: false,
      eligible: true,
      reason: null,
      activatedAt: null,
    };
    activateUncontained.mockImplementation(async (input: { pin: string }) => {
      expect(input).toEqual({ pin: "123456" });
      uncontainedStatus = {
        confirmed: true,
        active: true,
        eligible: true,
        reason: null,
        activatedAt: "2026-08-17T12:00:00.000Z",
      };
      return { ok: true as const };
    });
    disableUncontained.mockImplementation(async () => {
      uncontainedStatus = {
        confirmed: true,
        active: false,
        eligible: true,
        reason: null,
        activatedAt: null,
      };
      return { ok: true as const };
    });
    const view = render(<DesktopFilesystemAccessSection />);
    expect(await view.findByText(/commands run as this macOS account across everything it can access/i)).toBeTruthy();
    expect(view.getByText(/current folder is not a security boundary/i)).toBeTruthy();
    const enable = view.getByRole("button", { name: "Enable uncontained host commands with your PIN" });
    await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(enable);
    fireEvent.click(view.getByRole("button", { name: "Submit test PIN" }));
    await waitFor(() => {
      expect(activateUncontained).toHaveBeenCalledWith({ pin: "123456" });
      expect(view.getByText("On this session")).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: "Disable uncontained host commands immediately" }));
    await waitFor(() => {
      expect(disableUncontained).toHaveBeenCalledTimes(1);
      expect(view.getByRole("button", { name: "Enable uncontained host commands with your PIN" })).toBeTruthy();
    });
  });

  test("keeps uncontained activation disabled when the server reports ineligible", async () => {
    uncontainedStatus = {
      confirmed: true,
      active: false,
      eligible: false,
      reason: "grant_missing",
      activatedAt: null,
    };
    const view = render(<DesktopFilesystemAccessSection />);
    const enable = await view.findByRole("button", { name: "Enable uncontained host commands with your PIN" });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByText(/not eligible: grant missing/i)).toBeTruthy();
  });

  test("clears and revalidates confirmed uncontained state from footer, policy, auth, and visibility events", async () => {
    uncontainedStatus = {
      confirmed: true,
      active: true,
      eligible: true,
      reason: null,
      activatedAt: "2026-08-17T12:00:00.000Z",
    };
    const view = render(<DesktopFilesystemAccessSection />);
    expect(await view.findByText("On this session")).toBeTruthy();

    let releaseRefresh: ((value: typeof uncontainedStatus) => void) | null = null;
    getUncontainedStatus.mockImplementationOnce(() => new Promise((resolve) => {
      releaseRefresh = resolve;
    }));
    act(() => window.dispatchEvent(new CustomEvent("nautilo:uncontained-host-commands-changed")));
    await waitFor(() => expect(view.getByText("Checking")).toBeTruthy());
    act(() => releaseRefresh?.(uncontainedStatus));
    expect(await view.findByText("On this session")).toBeTruthy();

    for (const eventName of ["nautilo:policy-changed", "nautilo:auth-changed"] as const) {
      const callsBefore = getUncontainedStatus.mock.calls.length;
      act(() => window.dispatchEvent(new Event(eventName)));
      await waitFor(() => expect(getUncontainedStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    }
    const callsBeforeVisibility = getUncontainedStatus.mock.calls.length;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(getUncontainedStatus.mock.calls.length).toBeGreaterThan(callsBeforeVisibility));
  });

  test("cannot restore On when an older uncontained status request resolves after lifecycle truth", async () => {
    const staleActive = {
      confirmed: true,
      active: true,
      eligible: true,
      reason: null,
      activatedAt: "2026-08-17T12:00:00.000Z",
    };
    const newerUnavailable = {
      confirmed: false,
      active: false,
      eligible: false,
      reason: "server_status_unavailable",
      activatedAt: null,
    };
    let resolveOld: ((value: typeof staleActive) => void) | null = null;
    getUncontainedStatus.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOld = resolve;
    })).mockImplementationOnce(async () => newerUnavailable);

    const view = render(<DesktopFilesystemAccessSection />);
    await waitFor(() => expect(getUncontainedStatus).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("nautilo:auth-changed")));
    await waitFor(() => {
      expect(getUncontainedStatus).toHaveBeenCalledTimes(2);
      expect(view.getByText("Unavailable")).toBeTruthy();
    });

    act(() => resolveOld?.(staleActive));
    await waitFor(() => {
      expect(view.queryByText("On this session")).toBeNull();
      expect(view.getByText("Unavailable")).toBeTruthy();
    });
  });

  test("does not render outside the desktop shell", () => {
    const view = render(<DesktopFilesystemAccessSection isDesktopShell={false} />);
    expect(view.queryByTestId("workstation-access-section")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  test("explains Current Folder authority separately from additional recursive grants", async () => {
    grants = [activeGrant()];
    const view = render(<DesktopFilesystemAccessSection />);

    await waitFor(() => {
      expect(view.getByText("/Users/alice/Documents/approved")).toBeTruthy();
    });

    expect(view.getByText("read, create_modify")).toBeTruthy();
    expect(view.getByText("durable / user_picker")).toBeTruthy();
    expect(view.getByRole("button", { name: "Revoke access to /Users/alice/Documents/approved" })).toBeTruthy();
    expect(view.getByText("Additional guarded locations")).toBeTruthy();
    expect(view.getByText(/do not add it again below/i)).toBeTruthy();
    expect(view.getByText(/covers safe canonical descendants for its declared operations/i)).toBeTruthy();
    expect(view.getByText(/protected paths, identity checks, approvals, OS controls/i)).toBeTruthy();
  });

  test("manages host command access alongside the other workstation controls", async () => {
    shellConsent = "session";
    const view = render(<DesktopFilesystemAccessSection />);

    expect(await view.findByRole("heading", { name: "Host command access" })).toBeTruthy();
    expect(await view.findByText("Allowed this session")).toBeTruthy();
    expect(view.getByText("/Users/alice/project")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Revoke host command access" }));

    await waitFor(() => {
      expect(revokeShell).toHaveBeenCalledTimes(1);
      expect(view.getByText("Consent on first use")).toBeTruthy();
    });
    expect(view.queryByRole("button", { name: "Revoke host command access" })).toBeNull();
  });

  test("shows durable host command access distinctly", async () => {
    shellConsent = "durable";
    const view = render(<DesktopFilesystemAccessSection />);

    expect(await view.findByText("Always allowed")).toBeTruthy();
    expect(view.getByText("/Users/alice/project")).toBeTruthy();
  });

  test("picks and validates without auto-creating, then creates only selected operations", async () => {
    const view = render(<DesktopFilesystemAccessSection />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    fireEvent.click(view.getByRole("button", { name: "Add location" }));

    await waitFor(() => {
      expect(validate).toHaveBeenCalledWith("/Users/alice/Documents/approved");
      expect(view.getByText("Choose allowed operations")).toBeTruthy();
    });

    expect(create).not.toHaveBeenCalled();
    fireEvent.click(view.getByLabelText("Read files"));
    expect((view.getByLabelText("Read files") as HTMLInputElement).checked).toBe(true);
    const createButton = view.getByRole("button", { name: "Create additional guarded location" });
    expect((createButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        canonicalRoot: "/Users/alice/Documents/approved",
        filesystemIdentity: {
          realRoot: "/Users/alice/Documents/approved",
          device: 1,
          inode: 2,
        },
        access: ["read"],
        lifetime: "durable",
      });
    });
  });

  test("revokes a loaded grant", async () => {
    grants = [activeGrant("grant-revoke")];
    const view = render(<DesktopFilesystemAccessSection />);

    const button = await view.findByRole("button", {
      name: "Revoke access to /Users/alice/Documents/approved",
    });
    fireEvent.click(button);

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("grant-revoke"));
    await waitFor(() => {
      expect(view.getByText("No additional guarded Desktop file locations have been granted.")).toBeTruthy();
    });
  });

  test("reviews and acknowledges the seed without activating it", async () => {
    const view = render(<DesktopFilesystemAccessSection />);

    await waitFor(() => {
      expect(view.getByText("No renderer-provided executable or filesystem rules.")).toBeTruthy();
    });
    const developerDetails = view
      .getByRole("heading", { name: "Developer environment" })
      .closest("details");
    expect(developerDetails?.open).toBe(false);
    fireEvent.click(view.getByRole("switch", { name: "Turn on developer environment" }));
    expect(developerDetails?.open).toBe(true);

    expect(view.getByText(/does not grant root or administrator access/i)).toBeTruthy();
    expect(view.getByText(/exfiltration risk/i)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Acknowledge and prepare Developer Workstation" }));

    await waitFor(() => {
      expect(materializeSeedProfile).toHaveBeenCalled();
      expect(view.getByRole("button", { name: "Enable Developer Workstation with PIN" })).toBeTruthy();
    });
    expect(selectActiveProfile).not.toHaveBeenCalled();
  });

  test("enables the materialized profile only with the submitted PIN and disables it", async () => {
    const view = render(<DesktopFilesystemAccessSection />);
    await view.findByRole("button", { name: "Acknowledge and prepare Developer Workstation" });

    fireEvent.click(view.getByRole("button", { name: "Acknowledge and prepare Developer Workstation" }));
    const enable = await view.findByRole("button", { name: "Enable Developer Workstation with PIN" });
    expect(enable).toBeTruthy();
    fireEvent.click(view.getByRole("switch", { name: "Turn on developer environment" }));

    fireEvent.click(view.getByRole("button", { name: "Submit test PIN" }));

    await waitFor(() => {
      expect(selectActiveProfile).toHaveBeenCalledWith({
        profileId: "developer-workstation",
        profileRevision: 4,
        pin: "123456",
      });
      expect(view.getByText(/Active for this session/)).toBeTruthy();
    });

    fireEvent.click(view.getByRole("switch", { name: "Turn off developer environment" }));
    await waitFor(() => {
      expect(deactivateActiveProfile).toHaveBeenCalled();
      expect(view.getByRole("button", { name: "Enable Developer Workstation with PIN" })).toBeTruthy();
    });
  });

  test("refreshes when the footer changes the authoritative profile session", async () => {
    const view = render(<DesktopFilesystemAccessSection />);
    await view.findByRole("switch", { name: "Turn on developer environment" });

    activeProfileSummary = {
      profileId: "developer-workstation",
      profileRevision: 4,
      protectedPolicyVersion: 1,
      networkMode: "host",
      capabilities: [{ id: "developer_tools", backend: "local_process" }],
      compiledAt: "2026-07-13T12:00:00.000Z",
    };
    publishWorkstationProfileChanged("footer");

    await waitFor(() => {
      expect(view.getByRole("switch", { name: "Turn off developer environment" })).toBeTruthy();
    });
  });

  test("uses the compact PIN prompt after the user acknowledged this revision", async () => {
    const view = render(<DesktopFilesystemAccessSection />);
    await view.findByText("Discovery review");
    await view.findByRole("button", { name: "Acknowledge and prepare Developer Workstation" });
    fireEvent.click(view.getByRole("button", { name: "Acknowledge and prepare Developer Workstation" }));
    await view.findByRole("button", { name: "Enable Developer Workstation with PIN" });

    expect(runDiscoveryReview).toHaveBeenCalledTimes(1);
    view.unmount();

    listProfiles.mockImplementation(async () => ({
      ok: true as const,
      data: {
        profiles: [{
          id: "developer-workstation",
          revision: 4,
          name: "Developer Workstation",
          protectedPolicyVersion: 1,
          networkMode: "host" as const,
          capabilities: [{ id: "developer_tools", backend: "local_process" as const }],
          createdAt: "2026-07-13T12:00:00.000Z",
          updatedAt: "2026-07-13T12:00:00.000Z",
        }],
        revision: 1,
      },
    }));
    const restartedView = render(<DesktopFilesystemAccessSection />);
    await restartedView.findByRole("button", { name: "Enable Developer Workstation with PIN" });
    expect(runDiscoveryReview).toHaveBeenCalledTimes(1);
    expect(restartedView.queryByText("Discovery review")).toBeNull();
    expect(restartedView.getByText(/Enable for this app session with your own PIN/i)).toBeTruthy();
  });

  test("keeps protected filesystem access while hiding workstation controls without authority", async () => {
    capabilities = [];
    const view = render(<DesktopFilesystemAccessSection />);
    expect(await view.findByRole("heading", { name: "Protected access" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Developer environment" })).toBeNull();
    expect(view.queryByRole("heading", { name: "Host command access" })).toBeNull();
    expect(view.queryByRole("switch", { name: /developer environment/i })).toBeNull();
    expect(getSeedDescriptor).not.toHaveBeenCalled();
    expect(runDiscoveryReview).not.toHaveBeenCalled();
    expect(listProfiles).not.toHaveBeenCalled();
  });
});
