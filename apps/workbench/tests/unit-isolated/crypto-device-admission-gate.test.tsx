import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { ConnectionSegment } from "../../src/components/footer/connection-segment";
import { RuntimeShellStateContext, WsStateContext } from "../../src/adapters/runtime-contexts";
import { createWorkbenchPortal } from "../../src/components/workbench-portals";

let pathname = "/rooms/room-1";
let requiresCryptoDevice = true;
let localStatus: "active" | "setup_required" = "active";
let localDeviceId = "browser-device";
let admittedDeviceId = "browser-device";
let serverStatus: "admitted" | "required" = "required";
let credentialGeneration = 1;
let viewerGeneration = 1;
let releasePolicy: (() => void) | null = null;
let policyError: Error | null = null;
let challengeError: Error | null = null;
const signIn = mock(() => Promise.resolve());
const signOut = mock(() => Promise.resolve());

const inspect = mock(async () => localStatus === "active"
  ? { status: "active" as const, coordinates: { deviceId: "browser-device" } }
  : { status: "setup_required" as const });
const deviceAdmissionDeviceId = mock(async () => localStatus === "active"
  ? localDeviceId : null);
const signDeviceAdmissionChallenge = mock(async () => ({ signature: true }));
const getPolicy = mock(async () => {
  if (releasePolicy !== null) {
    await new Promise<void>((resolve) => {
      const release = releasePolicy;
      releasePolicy = () => {
        release?.();
        resolve();
      };
    });
  }
  if (policyError !== null) throw policyError;
  return {
    requiresCryptoDevice,
    policy: {
      mode: requiresCryptoDevice ? "encrypted_only" as const : "plaintext_only" as const,
      shadowBehavior: "fallback" as const,
    },
  };
});
const status = mock(async () => serverStatus === "admitted"
  ? {
      status: "admitted" as const,
      deviceId: admittedDeviceId,
      expiresAt: Date.now() + 60_000,
    }
  : {
      status: "required" as const,
      reason: "device_admission_required" as const,
    });
const challenge = mock(async () => {
  if (challengeError !== null) throw challengeError;
  return { challenge: { challenge: true } };
});
const prove = mock(async () => ({
  status: "admitted" as const,
  deviceId: "browser-device",
  expiresAt: Date.now() + 60_000,
}));
const readiness = {
  inspect,
  deviceAdmissionDeviceId,
  signDeviceAdmissionChallenge,
};

function successfulPolicy() {
  return {
    requiresCryptoDevice: true,
    policy: {
      mode: "encrypted_only" as const,
      shadowBehavior: "fallback" as const,
    },
  };
}

mock.module("react-router-dom", () => ({
  useLocation: () => ({ pathname }),
}));

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    session: { signIn, signOut },
    credentialGeneration,
    viewerGeneration,
    viewer: {
      sessionUserId: "user-1",
      sessionActorId: "human-1",
    },
  }),
}));

mock.module("../../src/hooks/use-can", () => ({
  useCan: () => (capability: string) => capability === "manage_server_settings",
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    admin: { encryptionTransition: { getPolicy } },
    deviceAdmission: { status, challenge, prove },
  },
}));

mock.module("../../src/contexts/encryption-readiness-context", () => ({
  useEncryptionReadinessClient: () => readiness,
}));

mock.module(
  "../../src/pages/settings/sections/encrypted-recovery-section",
  () => ({
    EncryptedRecoverySection: ({
      showPersonalCoverage,
    }: Readonly<{ showPersonalCoverage?: boolean }>) => (
      <div data-show-personal-coverage={String(showPersonalCoverage)}>
        Existing enrollment journey
      </div>
    ),
  }),
);

mock.module(
  "../../src/pages/admin/sections/encryption-transition-card",
  () => ({ EncryptionTransitionCard: () => <div>Policy rollback card</div> }),
);

const { CryptoDeviceAdmissionGate } = await import(
  "../../src/components/crypto-device-admission-gate"
);
const { requestCryptoAdmissionRefresh } = await import(
  "../../src/lib/crypto-admission-access"
);
const { getCryptoAdmissionSnapshot } = await import(
  "../../src/lib/crypto-admission-access"
);

let childMounts = 0;
let childUnmounts = 0;

function StatefulProduct() {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    childMounts += 1;
    return () => { childUnmounts += 1; };
  }, []);
  return (
    <div>
      <p>Protected product</p>
      <label>
        Draft
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
    </div>
  );
}

function Gate({ children }: Readonly<{ children?: ReactNode }>) {
  return (
    <CryptoDeviceAdmissionGate>
      {children ?? <div>Protected product</div>}
    </CryptoDeviceAdmissionGate>
  );
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  pathname = "/rooms/room-1";
  requiresCryptoDevice = true;
  localStatus = "active";
  localDeviceId = "browser-device";
  admittedDeviceId = "browser-device";
  serverStatus = "required";
  credentialGeneration = 1;
  viewerGeneration = 1;
  releasePolicy = null;
  policyError = null;
  challengeError = null;
  childMounts = 0;
  childUnmounts = 0;
  signIn.mockReset();
  signIn.mockImplementation(() => Promise.resolve());
  signOut.mockReset();
  signOut.mockImplementation(() => Promise.resolve());
  inspect.mockClear();
  deviceAdmissionDeviceId.mockClear();
  signDeviceAdmissionChallenge.mockClear();
  getPolicy.mockClear();
  status.mockClear();
  challenge.mockClear();
  prove.mockClear();
});

afterEach(() => cleanup());

describe("M303 Browser/Desktop admission gate", () => {
  test("product body portals retain state but inherit pause and explicit-denial hiding", async () => {
    serverStatus = "admitted";
    function ProductPopup() {
      const [draft, setDraft] = useState("popup draft");
      return createWorkbenchPortal(
        <input aria-label="Portal draft" value={draft} onChange={(event) => setDraft(event.target.value)} />,
        document.body,
      );
    }
    const view = render(<Gate><StatefulProduct /><ProductPopup /></Gate>);
    const popup = await view.findByRole("textbox", { name: "Portal draft" });
    fireEvent.change(popup, { target: { value: "retained confidential popup" } });
    expect(popup.closest("[data-workbench-portals]")).not.toBeNull();
    expect(popup.closest("[hidden], [inert]")).toBeNull();

    act(() => requestCryptoAdmissionRefresh("transport_disconnected"));
    expect(popup.closest("[inert]")).not.toBeNull();
    expect(popup.closest("[hidden]")).toBeNull();

    act(() => requestCryptoAdmissionRefresh("device_removed_or_stale"));
    expect(popup.closest("[hidden]")).not.toBeNull();
    expect(view.queryByRole("textbox", { name: "Portal draft" })).toBeNull();
    expect((popup as HTMLInputElement).value).toBe("retained confidential popup");
    const retry = view.getByRole("button", { name: "Retry" });
    expect(retry.closest("[hidden], [inert]")).toBeNull();

    fireEvent.click(retry);
    await waitFor(() => expect(popup.closest("[hidden], [inert]")).toBeNull());
    expect(view.getByRole("textbox", { name: "Portal draft" }) === popup).toBe(true);
    expect((popup as HTMLInputElement).value).toBe("retained confidential popup");
    expect(childMounts).toBe(1);
  });

  test("keeps first-load authentication failure behind Retry and safe server details", async () => {
    policyError = new Error("Authentication required");
    const view = render(<Gate />);
    expect(await view.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(view.getByText("Server details")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Sign in again" })).toBeNull();
    expect(view.queryByText("Protected product")).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    expect(deviceAdmissionDeviceId).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  test("first-load Retry keeps product locked until policy succeeds", async () => {
    policyError = new Error("Authentication required");
    const view = render(<Gate />);
    const retry = await view.findByRole("button", { name: "Retry" });
    policyError = null;
    fireEvent.click(retry);
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
    expect(signIn).not.toHaveBeenCalled();
  });

  test("first-load failure never exposes product before Retry succeeds", async () => {
    policyError = new Error("Authentication required");
    const view = render(<Gate />);
    await view.findByRole("button", { name: "Retry" });
    expect(view.queryByText("Protected product")).toBeNull();
  });

  test("keeps a voluntary account switch reachable from first-load recovery", async () => {
    policyError = new TypeError("Failed to fetch");
    const view = render(<Gate />);
    fireEvent.click(await view.findByRole("button", { name: "Switch account" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(view.queryByText("Protected product")).toBeNull();
  });
  test("opens plaintext without touching local crypto custody", async () => {
    requiresCryptoDevice = false;
    const view = render(<Gate />);
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
    expect(inspect).not.toHaveBeenCalled();
  });

  test("does not claim encryption is enabled when policy validation fails", async () => {
    policyError = new Error("policy response did not match the current schema");
    const view = render(<Gate />);
    await waitFor(() =>
      expect(view.getByText("Reconnecting to your workspace")).toBeTruthy()
    );
    expect(view.getByText(/security check could not finish/i)).toBeTruthy();
    expect(view.queryByText(/Encryption is enabled on this server/i)).toBeNull();
    expect(view.queryByText("Existing enrollment journey")).toBeNull();
    expect(view.queryByText("Protected product")).toBeNull();
  });

  test("treats a restart as a connection interruption and retries without opening product data", async () => {
    policyError = new TypeError("Failed to fetch");
    const view = render(<Gate />);
    expect(view.getByText("Connecting to your workspace")).toBeTruthy();
    await waitFor(() => expect(view.getByText("Reconnecting to your workspace")).toBeTruthy());
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText("Existing enrollment journey")).toBeNull();
    expect(view.queryByText("Protected product")).toBeNull();
    expect(view.getByText("Server details").parentElement?.hasAttribute("open")).toBe(false);
    policyError = null;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
    expect(prove).toHaveBeenCalledTimes(1);
  });

  test("recovers automatically when the server returns", async () => {
    policyError = new TypeError("Failed to fetch");
    const view = render(<Gate />);
    await waitFor(() => expect(view.getByText("Reconnecting to your workspace")).toBeTruthy());
    policyError = null;
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy(), { timeout: 3000 });
  });

  test("retries immediately when connectivity returns", async () => {
    policyError = new TypeError("Failed to fetch");
    const view = render(<Gate />);
    await waitFor(() => expect(view.getByText("Reconnecting to your workspace")).toBeTruthy());
    policyError = null;
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
  });

  test("ignores an old session check and keeps retrying the current session", async () => {
    let finishOld!: (value: { requiresCryptoDevice: boolean }) => void;
    getPolicy.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const view = render(<Gate />);
    policyError = new TypeError("Failed to fetch");
    viewerGeneration += 1;
    view.rerender(<Gate />);
    await waitFor(() => expect(view.getByText("Connecting to your workspace")).toBeTruthy());
    await act(async () => { finishOld({ requiresCryptoDevice: false }); });
    expect(view.queryByText("Protected product")).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    policyError = null;
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
  });

  test("a manual retry invalidates but does not overlap a stalled single-flight request", async () => {
    let finishOld!: (value: {
      requiresCryptoDevice: boolean;
      policy: { mode: "plaintext_only"; shadowBehavior: "fallback" };
    }) => void;
    let oldSignal: AbortSignal | undefined;
    getPolicy.mockImplementationOnce((options?: { signal?: AbortSignal }) => {
      oldSignal = options?.signal;
      return new Promise((resolve) => { finishOld = resolve; });
    });
    const view = render(<Gate />);
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(getPolicy).toHaveBeenCalledTimes(1);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      finishOld({
        requiresCryptoDevice: false,
        policy: { mode: "plaintext_only", shadowBehavior: "fallback" },
      });
    });
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
    expect(getPolicy).toHaveBeenCalledTimes(2);
    expect(prove).toHaveBeenCalledTimes(1);
  });

  test("Retry aborts a cancellable stalled check before starting the replacement", async () => {
    let firstSignal: AbortSignal | undefined;
    getPolicy.mockImplementationOnce((options?: { signal?: AbortSignal }) => {
      firstSignal = options?.signal;
      return new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    });
    const view = render(<Gate />);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    expect(firstSignal?.aborted).toBe(true);
    await waitFor(() => expect(getPolicy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
  });

  test("a same-session admission rejection supersedes an outstanding success", async () => {
    let finishOld!: (value: {
      status: "admitted";
      deviceId: string;
      expiresAt: number;
    }) => void;
    status.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const view = render(<Gate />);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    policyError = new TypeError("Failed to fetch");
    act(() => { requestCryptoAdmissionRefresh("device_admission_required"); });
    await waitFor(() => expect(view.getByText("Connecting to your workspace")).toBeTruthy());
    await act(async () => {
      finishOld({
        status: "admitted",
        deviceId: "browser-device",
        expiresAt: Date.now() + 60_000,
      });
    });
    expect(view.queryByText("Protected product")).toBeNull();
    policyError = null;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
  });

  test("does not disguise a local encryption failure as a server outage", async () => {
    deviceAdmissionDeviceId.mockImplementationOnce(async () => { throw new TypeError("Local key unavailable"); });
    const view = render(<Gate />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Local key unavailable"));
    expect(view.queryByText("Reconnecting to your workspace")).toBeNull();
    expect(view.queryByText("Protected product")).toBeNull();
  });

  test("silently proves an active device before opening product providers", async () => {
    const view = render(<Gate />);
    expect(view.queryByText("Protected product")).toBeNull();
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
    expect(inspect).not.toHaveBeenCalled();
    expect(deviceAdmissionDeviceId).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    expect(challenge).toHaveBeenCalledWith(
      {
        requestVersion: 1,
        deviceId: "browser-device",
      },
      expect.objectContaining({ signal: expect.anything() as unknown }),
    );
    expect(signDeviceAdmissionChallenge).toHaveBeenCalledTimes(1);
    expect(prove).toHaveBeenCalledTimes(1);
  });

  test("reuses the existing enrollment surface for an unready installation", async () => {
    localStatus = "setup_required";
    const view = render(<Gate />);
    await waitFor(() =>
      expect(view.getByText("Existing enrollment journey")).toBeTruthy()
    );
    expect(view.getByText("Existing enrollment journey")
      .getAttribute("data-show-personal-coverage")).toBe("false");
    expect(view.queryByText("Protected product")).toBeNull();
    expect(challenge).not.toHaveBeenCalled();
  });

  test("local custody never bypasses a server rejection of removed membership", async () => {
    challengeError = new Error("device_removed_or_stale");
    const view = render(<Gate />);
    await waitFor(() => expect(view.getByRole("alert").textContent)
      .toBe("device_removed_or_stale"));
    expect(view.queryByText("Protected product")).toBeNull();
    expect(signDeviceAdmissionChallenge).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  test("isolates the minimal Admin rollback route from product providers", async () => {
    pathname = "/admin/encryption";
    const view = render(<Gate />);
    await waitFor(() => expect(view.getByText("Policy rollback card")).toBeTruthy());
    expect(view.queryByText("Protected product")).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  });

  test("a cold 401 gate retries when same-account credentials arrive", async () => {
    policyError = new ApiError(401, "Authentication required");
    const view = render(<Gate><StatefulProduct /></Gate>);
    await waitFor(() => expect(view.getByText("Authentication required")).toBeTruthy());
    expect(childMounts).toBe(0);
    expect(status).not.toHaveBeenCalled();

    policyError = null;
    credentialGeneration += 1;
    view.rerender(<Gate><StatefulProduct /></Gate>);

    await view.findByText("Protected product");
    expect(getPolicy).toHaveBeenCalledTimes(2);
    expect(prove).toHaveBeenCalledTimes(1);
    expect(childMounts).toBe(1);
    expect(childUnmounts).toBe(0);
    expect(getCryptoAdmissionSnapshot().status).toBe("open");
  });

  test("cold credential arrival discards an in-flight check before admitting the current account", async () => {
    let finishOld!: (value: ReturnType<typeof successfulPolicy>) => void;
    let oldSignal: AbortSignal | undefined;
    getPolicy.mockImplementationOnce((options?: {signal?: AbortSignal}) => {
      oldSignal = options?.signal;
      return new Promise(resolve => {finishOld = resolve;});
    });
    const view = render(<Gate><StatefulProduct /></Gate>);
    credentialGeneration += 1;
    view.rerender(<Gate><StatefulProduct /></Gate>);
    expect(oldSignal?.aborted).toBe(true);
    expect(getPolicy).toHaveBeenCalledTimes(1);
    expect(childMounts).toBe(0);
    await act(async () => {finishOld(successfulPolicy());});
    await view.findByText("Protected product");
    expect(getPolicy).toHaveBeenCalledTimes(2);
    expect(prove).toHaveBeenCalledTimes(1);
    expect(childMounts).toBe(1);
  });

  test("pauses synchronously without unmounting when the session credential changes", async () => {
    serverStatus = "admitted";
    const view = render(<Gate />);
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());

    let release!: () => void;
    releasePolicy = () => release();
    const pendingPolicy = new Promise<void>((resolve) => { release = resolve; });
    credentialGeneration += 1;
    view.rerender(<Gate />);
    expect(view.getByText("Protected product")).toBeTruthy();
    expect(view.queryByText("Reconnecting securely…")).toBeNull();
    expect(view.queryByRole("region", { name: "Connection recovery" })).toBeNull();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.getByText("Protected product").parentElement?.hasAttribute("inert"))
      .toBe(true);

    releasePolicy?.();
    await pendingPolicy;
    await waitFor(() => expect(getCryptoAdmissionSnapshot().status).toBe("open"));
    expect(view.queryByRole("region", { name: "Connection recovery" })).toBeNull();
  });

  test("keeps the admitted workspace visible but inert on same-account 401 refresh failure", async () => {
    serverStatus = "admitted";
    const view = render(<Gate><StatefulProduct /></Gate>);
    await view.findByText("Protected product");
    policyError = new ApiError(401, "Authentication required");

    credentialGeneration += 1;
    view.rerender(<Gate><StatefulProduct /></Gate>);

    await waitFor(() => expect(getCryptoAdmissionSnapshot().status).toBe("paused"));
    expect(view.queryByText("Reconnecting securely…")).toBeNull();
    expect(view.getByText("Protected product")).toBeTruthy();
    expect(childMounts).toBe(1);
    expect(childUnmounts).toBe(0);
    expect(getCryptoAdmissionSnapshot().status).toBe("paused");
  });

  test("preserves the exact child and in-memory draft through timeout, 429, and 503 refresh failures", async () => {
    serverStatus = "admitted";
    const view = render(<Gate><StatefulProduct /></Gate>);
    const draft = await view.findByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "unsent words" } });
    expect(childMounts).toBe(1);

    for (const failure of [
      new TypeError("Failed to fetch"),
      new ApiError(429, "Too many requests"),
      new ApiError(503, "Service unavailable"),
    ]) {
      policyError = failure;
      act(() => requestCryptoAdmissionRefresh("encryption_policy_changed"));
      await waitFor(() => expect(getCryptoAdmissionSnapshot().status).toBe("paused"));
      expect(view.queryByText("Reconnecting securely…")).toBeNull();
      expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(view.getByRole("textbox", { name: "Draft", hidden: true }) === draft).toBe(true);
      expect((draft as HTMLInputElement).value).toBe("unsent words");
      expect(childMounts).toBe(1);
      expect(childUnmounts).toBe(0);
      expect(getCryptoAdmissionSnapshot().status).toBe("paused");

      policyError = null;
      act(() => requestCryptoAdmissionRefresh("online"));
      await waitFor(() => expect(getCryptoAdmissionSnapshot().status).toBe("open"));
      expect(view.queryByRole("region", { name: "Connection recovery" })).toBeNull();
      expect(view.getByRole("textbox", { name: "Draft" }) === draft).toBe(true);
    }
  });

  test("a transport disconnect immediately makes retained children inert without hot retry", async () => {
    serverStatus = "admitted";
    const view = render(<Gate><StatefulProduct /></Gate>);
    await view.findByText("Protected product");
    const checks = getPolicy.mock.calls.length;

    act(() => requestCryptoAdmissionRefresh("transport_disconnected"));

    expect(view.queryByText("Reconnecting securely…")).toBeNull();
    expect(view.queryByRole("region", { name: "Connection recovery" })).toBeNull();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.getByText("Protected product").parentElement?.parentElement
      ?.hasAttribute("inert")).toBe(true);
    expect(getPolicy).toHaveBeenCalledTimes(checks);
    expect(getCryptoAdmissionSnapshot().status).toBe("paused");

    act(() => requestCryptoAdmissionRefresh("transport_reconnected"));
    await waitFor(() => expect(getCryptoAdmissionSnapshot().status).toBe("open"));
    expect(view.queryByRole("region", { name: "Connection recovery" })).toBeNull();
  });


  test("returning to a visible session verifies silently while the socket stays connected", async () => {
    serverStatus = "admitted";
    const view = render(<Gate>
      <WsStateContext.Provider value={{ state: "open", lastOpenAt: Date.now() }}>
        <StatefulProduct /><ConnectionSegment />
      </WsStateContext.Provider>
    </Gate>);
    await view.findByText("Protected product");
    let release!: () => void;
    releasePolicy = () => release();
    const pending = new Promise<void>((resolve) => { release = resolve; });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(getCryptoAdmissionSnapshot().status).toBe("paused");
    expect(view.queryByText("Reconnecting securely…")).toBeNull();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(childMounts).toBe(1);
    releasePolicy?.();
    await pending;
    await waitFor(() => expect(getCryptoAdmissionSnapshot().status).toBe("open"));
  });

  test("a lost connection exposes only footer Retry outside inert and hides it on explicit denial", async () => {
    serverStatus = "admitted";
    const lastOpenAt = Date.now() - 60_000;
    const content = (connected: boolean) => (
      <Gate>
        <WsStateContext.Provider value={{ state: connected ? "open" : "closed", lastOpenAt }}>
          <RuntimeShellStateContext.Provider value={connected
            ? { kind: "authenticated_connected" }
            : { kind: "authenticated_disconnected", lastOpenAt }}>
            <StatefulProduct />
            <ConnectionSegment />
          </RuntimeShellStateContext.Provider>
        </WsStateContext.Provider>
      </Gate>
    );
    const view = render(content(true));
    await view.findByText("Protected product");
    act(() => requestCryptoAdmissionRefresh("transport_disconnected"));
    view.rerender(content(false));

    const retry = view.getByRole("button", { name: "Retry" });
    expect(retry.closest("[inert]")).toBeNull();
    expect(retry.closest("[data-connection-recovery-host]")).not.toBeNull();
    expect(view.getByText("Protected product").closest("[inert]")).not.toBeNull();
    expect(view.queryByText("Reconnecting securely…")).toBeNull();
    const calls = getPolicy.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(getPolicy.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(getCryptoAdmissionSnapshot().status).toBe("open"));
    view.rerender(content(true));
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(childMounts).toBe(1);

    act(() => requestCryptoAdmissionRefresh("transport_disconnected"));
    view.rerender(content(false));
    const retryAfterDisconnect = view.getByRole("button", { name: "Retry" });
    act(() => requestCryptoAdmissionRefresh("device_removed_or_stale"));
    expect(retryAfterDisconnect.closest("[hidden]")).not.toBeNull();
    expect(view.getByRole("button", { name: "Retry" })).not.toBe(retryAfterDisconnect);
  });

  test("an admission-expired rejection can reproof over HTTP while the socket is down", async () => {
    serverStatus = "admitted";
    const view = render(<Gate><StatefulProduct /></Gate>);
    await view.findByText("Protected product");
    act(() => requestCryptoAdmissionRefresh("transport_disconnected"));
    expect(getCryptoAdmissionSnapshot().status).toBe("paused");
    serverStatus = "required";

    act(() => requestCryptoAdmissionRefresh("device_admission_expired"));

    await waitFor(() => expect(prove).toHaveBeenCalledTimes(1));
    expect(getCryptoAdmissionSnapshot().status).toBe("open");
    expect(view.getByText("Protected product")).toBeTruthy();
  });

  test("explicit removal hides but retains the draft until Retry reproofs the same identity", async () => {
    serverStatus = "admitted";
    const view = render(<Gate><StatefulProduct /></Gate>);
    const draft = await view.findByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "keep me" } });

    act(() => requestCryptoAdmissionRefresh("device_removed_or_stale"));

    expect(getCryptoAdmissionSnapshot().status).toBe("blocked");
    expect(view.queryByRole("textbox", { name: "Draft" })).toBeNull();
    expect(view.getByRole("textbox", { name: "Draft", hidden: true })).toBe(draft);
    expect(childUnmounts).toBe(0);

    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(view.getByRole("textbox", { name: "Draft" })).toBe(draft));
    expect((draft as HTMLInputElement).value).toBe("keep me");
    expect(childMounts).toBe(1);
  });

  test("removal stays hidden through disconnect, failed Retry and pending reproof", async () => {
    serverStatus = "admitted";
    const view = render(<Gate><StatefulProduct /></Gate>);
    const draft = await view.findByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "still confidential" } });
    act(() => requestCryptoAdmissionRefresh("device_removed_or_stale"));
    act(() => requestCryptoAdmissionRefresh("transport_disconnected"));
    expect(getCryptoAdmissionSnapshot().status).toBe("blocked");
    expect(view.queryByRole("textbox", { name: "Draft" })).toBeNull();

    policyError = new TypeError("Failed to fetch");
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getPolicy).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(getCryptoAdmissionSnapshot().status).toBe("blocked");
    expect(view.queryByRole("textbox", { name: "Draft" })).toBeNull();

    policyError = null;
    let finish!: (value: ReturnType<typeof successfulPolicy>) => void;
    getPolicy.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(getCryptoAdmissionSnapshot().status).toBe("blocked");
    expect(view.queryByRole("textbox", { name: "Draft" })).toBeNull();
    await act(async () => finish(successfulPolicy()));
    await waitFor(() => expect(view.getByRole("textbox", { name: "Draft" })).toBe(draft));
    expect((draft as HTMLInputElement).value).toBe("still confidential");
    expect(childMounts).toBe(1);
  });

  test("an account generation change destroys the retained child before the new check settles", async () => {
    serverStatus = "admitted";
    const view = render(<Gate><StatefulProduct /></Gate>);
    await view.findByText("Protected product");
    let finishNew!: (value: ReturnType<typeof successfulPolicy>) => void;
    getPolicy.mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));

    viewerGeneration += 1;
    view.rerender(<Gate><StatefulProduct /></Gate>);

    expect(view.queryByText("Protected product")).toBeNull();
    expect(childUnmounts).toBe(1);
    await act(async () => finishNew(successfulPolicy()));
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
    expect(childMounts).toBe(2);
  });

  test("a local crypto device identity change destroys the prior child before fresh admission", async () => {
    serverStatus = "admitted";
    const view = render(<Gate><StatefulProduct /></Gate>);
    await view.findByText("Protected product");

    localDeviceId = "replacement-device";
    admittedDeviceId = "replacement-device";
    act(() => requestCryptoAdmissionRefresh("encryption_policy_changed"));

    await waitFor(() => expect(childUnmounts).toBe(1));
    await waitFor(() => expect(view.getByText("Protected product")).toBeTruthy());
    expect(childMounts).toBe(2);
    expect(getCryptoAdmissionSnapshot().identity).toContain("device:replacement-device");
  });

  test("server admission expiry pauses and reproofs from the authoritative expiresAt", async () => {
    serverStatus = "required";
    status.mockImplementationOnce(async () => ({
      status: "admitted" as const,
      deviceId: "browser-device",
      expiresAt: Date.now() + 60_000,
    }));
    const scheduled = spyOn(window, "setTimeout");
    try {
      const view = render(<Gate><StatefulProduct /></Gate>);
      await view.findByText("Protected product");
      const openedGeneration = getCryptoAdmissionSnapshot().generation;
      expect(prove).not.toHaveBeenCalled();

      // Fire the actual expiry callback after observing the initial admission.
      // A 20ms wall-clock expiry raced the first render on loaded CI runners.
      const expiry = scheduled.mock.calls.find(([, delay]) =>
        typeof delay === "number" && delay > 1_000 && delay <= 60_000);
      expect(expiry).toBeDefined();
      const expire = expiry![0];
      if (typeof expire !== "function") throw new Error("Missing admission expiry callback");
      act(() => expire());

      await waitFor(() => {
        expect(prove).toHaveBeenCalledTimes(1);
        expect(getCryptoAdmissionSnapshot().status).toBe("open");
        expect(getCryptoAdmissionSnapshot().generation).toBe(openedGeneration + 1);
      });
      expect(childMounts).toBe(1);
    } finally {
      scheduled.mockRestore();
    }
  });
});
