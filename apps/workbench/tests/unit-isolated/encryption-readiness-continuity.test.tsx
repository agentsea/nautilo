import "../bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

let viewer: {
  isVerified: boolean;
  staleWhoami: boolean;
  sessionUserId: string | null;
  sessionActorId: string | null;
} = {
  isVerified: true,
  staleWhoami: false,
  sessionUserId: "qa-user",
  sessionActorId: "qa-human",
};
const createClient = mock(() => ({
  inspect: async () => ({ status: "active" }),
  deviceAdmissionDeviceId: async () => "qa-device",
  signDeviceAdmissionChallenge: async () => ({}),
}));
mock.module("../../src/hooks/use-auth", () => ({ useAuth: () => ({ viewer }) }));
mock.module("../../src/lib/api", () => ({ apiClient: {} }));
mock.module("../../src/lib/desktop", () => ({ isDesktop: false, desktopAPI: undefined }));
mock.module("../../src/lib/browser-crypto-installation", () => ({
  readOrCreateBrowserCryptoInstallationId: () => "qa-installation",
  activateFreshBrowserCryptoInstallationId: () => true,
}));
mock.module("@nautilo/lattice-bridge/client/browser", () => ({ createBrowserInitialDeviceReadinessClient: createClient }));

const { EncryptionReadinessProvider, useEncryptionReadinessClient } = await import("../../src/contexts/encryption-readiness-context");
let observed: ReturnType<typeof useEncryptionReadinessClient>;
function Probe() {
  observed = useEncryptionReadinessClient();
  return null;
}
beforeEach(() => {
  viewer = {
    isVerified: true,
    staleWhoami: false,
    sessionUserId: "qa-user",
    sessionActorId: "qa-human",
  };
  createClient.mockClear();
});
afterEach(() => cleanup());

test("same-account stale whoami retains custody, but account change and logout do not", () => {
  const view = render(<EncryptionReadinessProvider><Probe /></EncryptionReadinessProvider>);
  const original = observed;
  expect(original).toBeDefined();
  expect(createClient).toHaveBeenCalledTimes(1);
  viewer = { ...viewer, staleWhoami: true };
  view.rerender(<EncryptionReadinessProvider><Probe /></EncryptionReadinessProvider>);
  expect(observed === original).toBe(true);
  expect(createClient).toHaveBeenCalledTimes(1);
  viewer = { ...viewer, staleWhoami: false };
  view.rerender(<EncryptionReadinessProvider><Probe /></EncryptionReadinessProvider>);
  expect(observed === original).toBe(true);
  viewer = { ...viewer, sessionUserId: "other-user", sessionActorId: "other-human" };
  view.rerender(<EncryptionReadinessProvider><Probe /></EncryptionReadinessProvider>);
  expect(observed === original).toBe(false);
  expect(createClient).toHaveBeenCalledTimes(2);
  viewer = { ...viewer, sessionUserId: null, sessionActorId: null };
  view.rerender(<EncryptionReadinessProvider><Probe /></EncryptionReadinessProvider>);
  expect(observed).toBeUndefined();
});

test("a resolved Guest retains device readiness without acquiring verification", () => {
  viewer = {
    isVerified: false,
    staleWhoami: false,
    sessionUserId: "guest-user",
    sessionActorId: "guest-human",
  };

  render(<EncryptionReadinessProvider><Probe /></EncryptionReadinessProvider>);

  expect(observed).toBeDefined();
  expect(createClient).toHaveBeenCalledTimes(1);
});

test.each([
  { sessionUserId: null, sessionActorId: "guest-human" },
  { sessionUserId: "guest-user", sessionActorId: null },
])("does not construct readiness without both canonical Human ids", (coordinates) => {
  viewer = {
    isVerified: false,
    staleWhoami: false,
    ...coordinates,
  };

  render(<EncryptionReadinessProvider><Probe /></EncryptionReadinessProvider>);

  expect(observed).toBeUndefined();
  expect(createClient).not.toHaveBeenCalled();
});
