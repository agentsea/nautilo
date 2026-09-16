import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..");
const webRoots = [
  "app/(onboarding)/add-server.web.tsx",
  "app/share.web.tsx",
  "components/drawer-content.web.tsx",
  "features/invite-redemption/invite-handoff.web.ts",
  "features/remote/controller-installation.web.ts",
  "lib/auth.web.ts",
  "lib/browser-entry.web.ts",
  "lib/inbound-share-custody.web.ts",
  "lib/inbound-share-file.web.ts",
  "lib/pending-share.web.ts",
  "lib/room-drafts.web.ts",
  "lib/share-handoff.web.ts",
  "lib/push-binding-store.web.ts",
  "providers/auth.web.tsx",
  "providers/inbound-intent.web.tsx",
  "providers/notification-state.web.tsx",
  "providers/push-lifecycle.web.tsx",
  "providers/server-registry.web.tsx",
  "providers/voice.web.tsx",
  "features/remote/remote-hosts.web.tsx",
];

test("every root-reachable native authority has an explicit Web projection", () => {
  for (const file of webRoots) {
    const source = readFileSync(resolve(SRC, file), "utf8");
    expect(source).not.toMatch(/from ["']expo-(?:audio|camera|device|file-system|notifications|secure-store|sharing)["']/);
    expect(source).not.toContain("prepareRemoteOrdinaryRequestProof");
  }
});

test("native SecureStore key names and record owner remain byte-compatible", () => {
  const nativeStore = readFileSync(resolve(SRC, "lib/server-store.ts"), "utf8");
  expect(nativeStore).toContain('const REGISTRY_KEY = "nautilo.servers.v1"');
  expect(nativeStore).toContain('const TOKENS_KEY_PREFIX = "nautilo.tokens."');
  expect(nativeStore).toContain('SecureStore.setItemAsync(TOKENS_KEY_PREFIX + id, JSON.stringify(tokens))');
  expect(nativeStore).toContain('SecureStore.deleteItemAsync(TOKENS_KEY_PREFIX + id)');
});

test("browser drafts do not carry native attachment state into the Web projection", () => {
  const browserDrafts = readFileSync(resolve(SRC, "lib/room-drafts.web.ts"), "utf8");
  expect(browserDrafts).not.toContain("expo-secure-store");
  expect(browserDrafts).not.toContain("custodyId");
});

test("browser Share route cannot import or claim native receipt custody", () => {
  const browserShareRoute = readFileSync(resolve(SRC, "app/share.web.tsx"), "utf8");
  expect(browserShareRoute).toContain('<Redirect href="/" />');
  expect(browserShareRoute).not.toMatch(/inbound-share|pending-share|share-handoff|SecureStore|expo-file-system/);
});

test("browser Share projections expose no native custody keys or module imports", () => {
  for (const file of [
    "lib/inbound-share-custody.web.ts",
    "lib/inbound-share-file.web.ts",
    "lib/pending-share.web.ts",
    "lib/share-handoff.web.ts",
  ]) {
    const source = readFileSync(resolve(SRC, file), "utf8");
    expect(source).not.toMatch(/nautilo\.(?:inbound-share-custody|pending-share)/);
    expect(source).not.toMatch(/modules\/nautilo-share-handoff|expo-secure-store|expo-file-system/);
  }
});

test("shared realtime owners consume the platform lifecycle authority", () => {
  for (const file of ["providers/realtime.tsx", "providers/artifact-events.tsx"]) {
    const source = readFileSync(resolve(SRC, file), "utf8");
    expect(source).toContain('from "@/platform/app-lifecycle"');
    expect(source).not.toContain("AppState.addEventListener");
  }
});

test("mandatory crypto admission stops Mobile product providers before mount", () => {
  const layout = readFileSync(resolve(SRC, "app/_layout.tsx"), "utf8");
  const boundary = readFileSync(resolve(SRC, "components/crypto-device-admission-boundary.tsx"), "utf8");
  const admissionOpen = layout.indexOf("<CryptoDeviceAdmissionBoundary>");
  const pushBridge = layout.indexOf("<PushLifecycleBridge />");
  const artifacts = layout.indexOf("<ArtifactEventsProvider>");
  const realtime = layout.indexOf("<RealtimeProvider>");
  const admissionClose = layout.indexOf("</CryptoDeviceAdmissionBoundary>");
  expect(admissionOpen).toBeGreaterThan(-1);
  expect(pushBridge).toBeGreaterThan(admissionOpen);
  expect(artifacts).toBeGreaterThan(admissionOpen);
  expect(realtime).toBeGreaterThan(admissionOpen);
  expect(admissionClose).toBeGreaterThan(realtime);
  expect(boundary).toContain("Use a different server");
  expect(boundary).toContain("await switchTo(serverId)");
  expect(boundary).toContain("const error = await addServer(serverUrl)");
});
