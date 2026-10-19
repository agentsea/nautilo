import { expect, test } from "bun:test";
import { createHumanTerminalAdmissionPort, type HumanTerminalSourceAdmission } from "../../src/conversation/human-terminal-admission";

function fixture() {
  const controller = new AbortController();
  let policy = { mode: "plaintext_only", revision: 1 };
  let scope: Awaited<ReturnType<HumanTerminalSourceAdmission["readScope"]>> = { roomId: "room", graphThreadId: "stored-thread", agentActorId: "actor" };
  let validateProtected = async () => {};
  const port = createHumanTerminalAdmissionPort({ signal: controller.signal,
    readPolicy: async () => ({ ...policy }), readScope: async () => scope,
    validateProtected: () => validateProtected(),
  });
  return { port, controller, setScope: (value: typeof scope) => { scope = value; },
    setPolicy: (value: typeof policy) => { policy = value; },
    setProtected: (value: () => Promise<void>) => { validateProtected = value; } };
}
async function denied(promise: Promise<unknown>) { expect(await promise.then(() => false, () => true)).toBeTrue(); }

test("fresh ordinary source gates both reads and input and returns their actual result", async () => {
  for (const action of ["read", "write"]) {
    const f = fixture(); let effects = 0;
    expect(await f.port.withAdmission(async signal => { expect(signal.aborted).toBeFalse(); effects++; return action; })).toBe(action);
    expect(effects).toBe(1);
    f.setScope(null);
    await denied(f.port.withAdmission(async () => { effects++; })); expect(effects).toBe(1);
  }
});
test("revocation after dispatch suppresses result without repeating its effect", async () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => f.setScope(null),
    (f: ReturnType<typeof fixture>) => f.setScope({ roomId: "room", graphThreadId: "stored-thread", agentActorId: "replacement" }),
    (f: ReturnType<typeof fixture>) => f.setPolicy({ mode: "plaintext_only", revision: 2 }),
    (f: ReturnType<typeof fixture>) => f.controller.abort(),
  ]) {
    const f = fixture(); let effects = 0;
    await denied(f.port.withAdmission(async () => { effects++; mutation(f); return "private-output"; }));
    expect(effects).toBe(1);
  }
});
test("protected admission failure or removal during protected validation denies before effects", async () => {
  for (const remove of [false, true]) {
    const f = fixture(); f.setPolicy({ mode: "full_encryption", revision: 1 }); let effects = 0;
    f.setProtected(async () => { if (remove) f.setScope(null); else throw new Error("revoked"); });
    await denied(f.port.withAdmission(async () => { effects++; })); expect(effects).toBe(0);
  }
});
test("protected source is revalidated before exposing the result", async () => {
  const f = fixture(); f.setPolicy({ mode: "shadow_encryption", revision: 1 }); let validations = 0; let effects = 0;
  f.setProtected(async () => { if (++validations === 2) throw new Error("revoked"); });
  await denied(f.port.withAdmission(async () => { effects++; return "secret"; }));
  expect(validations).toBe(2); expect(effects).toBe(1);
});

test("borrowed admission uses transaction readers with the original signal before and after the effect", async () => {
  const f = fixture(); let sourceReads = 0; let borrowedReads = 0; let effectSignal: AbortSignal | undefined;
  const borrowed = {
    readPolicy: async () => { borrowedReads++; return { mode: "plaintext_only", revision: 7 }; },
    readScope: async () => ({ roomId: "borrowed-room", graphThreadId: "borrowed-thread", agentActorId: "borrowed-agent" }),
    validateProtected: async () => { throw new Error("plain policy must not validate protected authority"); },
  };
  f.setPolicy({ mode: "plaintext_only", revision: 99 });
  f.setProtected(async () => { sourceReads++; });
  expect(await f.port.withBorrowedAdmission!(borrowed, async signal => { effectSignal = signal; return "captured"; })).toBe("captured");
  expect(effectSignal).toBe(f.controller.signal);
  expect(borrowedReads).toBe(4);
  expect(sourceReads).toBe(0);
});

test("borrowed admission suppresses results on stale policy or scope, protected denial, and original cancellation", async () => {
  for (const failure of ["scope", "policy", "protected", "abort"] as const) {
    const f = fixture(); let reads = 0; let policyReads = 0; let effects = 0;
    const borrowed = {
      readPolicy: async () => ({ mode: failure === "protected" ? "full_encryption" : "plaintext_only",
        revision: failure === "policy" && ++policyReads > 2 ? 2 : 1 }),
      readScope: async () => ({ roomId: "room", graphThreadId: "thread",
        agentActorId: failure === "scope" && ++reads > 2 ? "replacement" : "actor" }),
      validateProtected: async () => { if (failure === "protected") throw new Error("stale protected owner"); },
    };
    const result = f.port.withBorrowedAdmission!(borrowed, async () => {
      effects++;
      if (failure === "abort") f.controller.abort();
      return "private-result";
    });
    await denied(result);
    expect(effects).toBe(failure === "protected" ? 0 : 1);
  }
});

import type { NautiloState } from "@nautilo/agent";
import { foregroundHumanTerminalAdmissionPort, type HumanTerminalForegroundOwners } from "../../src/conversation/human-terminal-admission";

function foregroundFixture() {
  const state = { trustedExecutionEntrypoint: "foreground.main", causalHumanUserId: "human", agentId: "agent", roomId: "room", currentThreadId: "persisted-thread",
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human" } } as unknown as NautiloState;
  let mode = "plaintext_only"; let room = "room"; let crypto: unknown = undefined; let allowed = true; let workstationAllowed = true;
  const lookups: unknown[] = [];
  const owners = {
    readPolicy: async () => ({ mode, revision: 1 }),
    readSourceAuthority: async (input: { graphThreadId: string }) => {
      lookups.push(input);
      if (!allowed) throw new Error("denied");
      return workstationAllowed && room === "room"
        ? { roomId: "room", graphThreadId: "persisted-thread", agentActorId: "agent-actor" } : null;
    },
    getCurrentLiveShadowTurnContext: () => crypto,
  } as unknown as HumanTerminalForegroundOwners;
  const port = () => foregroundHumanTerminalAdmissionPort(state, new AbortController().signal, owners)!;
  return { port, lookups, state, owners, revokeWorkstation: () => { workstationAllowed = false; }, setRoom: (value: string) => { room = value; }, deny: () => { allowed = false; }, protected: (value: unknown) => { mode = "full_encryption"; crypto = value; } };
}
function protectedContext() {
  const policy = { mode: "full_encryption", revision: 1, shadowBehavior: "protected_only" };
  return { capability: { scope: { subjectHumanId: "human", roomId: "room", recipientAgentId: "agent" } },
    session: { authorizationSignal: new AbortController().signal, authorizationDeadlineAt: Date.now() + 60_000 },
    enforcementPolicy: policy,
    dataOperationPolicy: { resolve: async () => ({ policy, revalidationToken: 1 }), revalidate: async () => {} } };
}
test("foreground adapter uses persisted conversation and current Room/Agent admission", async () => {
  const f = foregroundFixture(); expect(await f.port().withAdmission(async () => "output")).toBe("output");
  expect(f.lookups).toContainEqual({ humanUserId: "human", agentId: "agent", roomId: "room", graphThreadId: "persisted-thread" });
  f.setRoom("foreign"); await denied(f.port().withAdmission(async () => { throw new Error("must not dispatch"); }));
  expect(foregroundHumanTerminalAdmissionPort({ ...f.state, verifiedOrdinaryOrigin: null }, new AbortController().signal, f.owners)).toBeUndefined();
});
test("production protected adapter rejects absent, wake, expired, foreign and changed policy owners", async () => {
  for (const variant of ["absent", "wake", "expired", "foreign", "behavior", "valid"]) {
    const f = foregroundFixture(); const crypto = protectedContext(); let effects = 0;
    if (variant === "expired") crypto.session.authorizationDeadlineAt = 0;
    if (variant === "foreign") crypto.capability.scope.recipientAgentId = "foreign";
    if (variant === "behavior") crypto.enforcementPolicy = { ...crypto.enforcementPolicy, shadowBehavior: "different" };
    f.protected(variant === "absent" ? undefined
      : variant === "wake" ? { ...crypto, capability: null } : crypto);
    const work = f.port().withAdmission(async () => { effects++; return "protected-output"; });
    if (variant === "valid") expect(await work).toBe("protected-output"); else await denied(work);
    expect(effects).toBe(variant === "valid" ? 1 : 0);
  }
});
test("foreground adapter suppresses output after source revocation and expired protected session", async () => {
  for (const protectedMode of [false, true]) {
    const f = foregroundFixture(); const crypto = protectedContext(); if (protectedMode) f.protected(crypto);
    let effects = 0; await denied(f.port().withAdmission(async () => { effects++; if (protectedMode) crypto.session.authorizationDeadlineAt = 0; else f.deny(); return "private"; }));
    expect(effects).toBe(1);
  }
});

test("required workstation permission is fresh before and after plain or protected effects", async () => {
  for (const protectedMode of [false, true]) {
    for (const before of [false, true]) {
      const f = foregroundFixture(); if (protectedMode) f.protected(protectedContext());
      if (before) f.revokeWorkstation(); let effects = 0;
      await denied(f.port().withAdmission(async () => { effects++; f.revokeWorkstation(); return "private-output"; }));
      expect(effects).toBe(before ? 0 : 1);
    }
  }
});
