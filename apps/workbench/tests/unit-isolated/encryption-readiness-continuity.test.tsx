import "../bun-dom-preload";
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

let viewer = { isVerified: true, staleWhoami: false, sessionUserId: "qa-user", sessionActorId: "qa-human" };
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
  viewer = { ...viewer, isVerified: false };
  view.rerender(<EncryptionReadinessProvider><Probe /></EncryptionReadinessProvider>);
  expect(observed).toBeUndefined();
});
