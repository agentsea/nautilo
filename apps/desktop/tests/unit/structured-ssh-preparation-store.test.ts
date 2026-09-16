import { describe, expect, test } from "bun:test";
import { SshPreparationStore } from "../../electron/structured-ssh/preparation-store.ts";

const subject = {
  instanceId: "",
  userId: "user-1",
  actorId: "actor-1",
  actorRole: "owner" as const,
  agentId: "agent-1",
  executionEntrypoint: "foreground.main" as const,
  relayId: "relay-1",
  relaySessionId: "session-1",
  desktopSessionId: "desktop-1",
  pairingGenerationRef: "pairing-1",
  capabilityRevision: 1,
};
const approval = {
  requestedDestination: { connection: "build-alias" },
  host: "build.example.test",
  port: 22,
  remoteUser: "deploy",
  operation: "exec" as const,
  hostKeyFingerprint: `SHA256:${"a".repeat(43)}`,
  hostTrust: "unknown" as const,
};
const trustDecision = { state: "unknown" as const, hostKeyFingerprint: approval.hostKeyFingerprint };
const destinationPlan = {
  destination: { host: "build.example.test", remoteUser: "deploy", port: 22 },
  identitySources: [],
  knownHostFiles: [],
  safetyDirectives: {},
} as const;

function createAt(start = 1_000, ttlMs = 10) {
  let milliseconds = start;
  const store = new SshPreparationStore({
    clock: () => new Date(milliseconds),
    ttlMs,
    idFactory: () => "ssh-preparation-1",
  });
  const created = store.create({
    toolCallId: "tool-call-1",
    approvedRequestDigest: "a".repeat(64),
    operation: "exec",
    subject,
    capabilityStoreRevision: 41,
    destinationPlan,
    destinationIntent: { connection: "build-alias" },
    connectionSource: { kind: "openssh", name: "build-alias" },
    semanticFingerprint: "a".repeat(64),
    trustDecision,
    approval,
  });
  if (!created.ok) throw new Error("preparation creation failed");
  return {
    store,
    use: (overrides: Partial<{ preparationId: string; toolCallId: string; approvedRequestDigest: string; operation: "exec"; subject: typeof subject }> = {}) => store.consume({
      preparationId: "ssh-preparation-1",
      toolCallId: "tool-call-1",
      approvedRequestDigest: "a".repeat(64),
      operation: "exec",
      subject,
      ...overrides,
    }),
    advance: (by: number) => { milliseconds += by; },
  };
}

describe("structured SSH preparation store", () => {
  test("retains an independent local capability-store revision and tombstones a tuple mismatch", () => {
    const fixture = createAt();
    expect(fixture.use({ approvedRequestDigest: "b".repeat(64) })).toMatchObject({ ok: false, code: "preparation_mismatch" });
    expect(fixture.use()).toMatchObject({ ok: false, code: "preparation_replayed" });
  });

  test("returns explicit expiry before purge and preserves a replay tombstone", () => {
    const expired = createAt();
    expired.advance(10);
    expect(expired.use()).toMatchObject({ ok: false, code: "preparation_expired" });

    const replayed = createAt();
    expect(replayed.use()).toMatchObject({ ok: true });
    expect(replayed.use()).toMatchObject({ ok: false, code: "preparation_replayed" });
  });

  test("rejects dynamic topology changes before the local preparation can be used", () => {
    const fixture = createAt();
    expect(fixture.use({ subject: { ...subject, relaySessionId: "session-2" } }))
      .toMatchObject({ ok: false, code: "preparation_mismatch" });
  });
});
