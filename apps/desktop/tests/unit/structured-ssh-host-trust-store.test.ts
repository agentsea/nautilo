import { describe, expect, test } from "bun:test";
import { SshHostTrustStore } from "../../electron/structured-ssh/host-trust-store.ts";

const clock = () => new Date("2026-08-06T12:00:00.000Z");
const target = { host: "build.example.test", port: 22 };
const first = "SHA256:host-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const changed = "SHA256:host-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function memoryStorage(initial: string | null = null) {
  let bytes = initial;
  let writes = 0;
  return {
    storage: { read: async () => bytes, writeAtomic: async (next: string) => { bytes = next; writes += 1; } },
    bytes: () => bytes,
    writes: () => writes,
  };
}

function makeStore(memory = memoryStorage(), instanceId = "nautilo-instance-1") {
  return { memory, store: new SshHostTrustStore({ instanceId, filePath: "/unused/structured-ssh-host-trust.json", storage: memory.storage, clock }) };
}

describe("structured SSH host trust store", () => {
  test("confirms and inspects one exact canonical host and port", async () => {
    const { store } = makeStore();
    expect((await store.lookup({ target })).data).toEqual({ state: "unknown" });
    expect((await store.inspect({ target, observedFingerprint: first })).data).toEqual({ state: "unknown" });
    expect((await store.confirm({ target, hostKeyFingerprint: first })).ok).toBe(true);
    expect((await store.lookup({ target })).data).toMatchObject({ state: "trusted", record: { hostKeyFingerprint: first } });
    expect((await store.inspect({ target, observedFingerprint: first })).data).toMatchObject({ state: "trusted", record: { host: target.host, port: 22, hostKeyFingerprint: first } });
    expect((await store.inspect({ target: { ...target, port: 2222 }, observedFingerprint: first })).data).toEqual({ state: "unknown" });
    expect((await store.inspect({ target, observedFingerprint: changed })).data).toMatchObject({ state: "changed", observedFingerprint: changed, record: { hostKeyFingerprint: first } });
  });

  test("never auto-trusts changed keys and records explicit replacement history", async () => {
    const { store } = makeStore();
    await store.confirm({ target, hostKeyFingerprint: first });
    expect(await store.confirm({ target, hostKeyFingerprint: changed })).toMatchObject({ ok: false, code: "trust_changed" });
    expect(await store.replace({ target, previousFingerprint: first, nextFingerprint: changed })).toMatchObject({ ok: true, data: { record: { hostKeyFingerprint: changed } } });
    expect((await store.inspect({ target, observedFingerprint: first })).data).toMatchObject({ state: "changed", record: { hostKeyFingerprint: changed } });
    expect((await store.inspect({ target, observedFingerprint: changed })).data).toMatchObject({ state: "trusted" });
  });

  test("removes an exact record without widening to a different fingerprint or port", async () => {
    const { store } = makeStore();
    await store.confirm({ target, hostKeyFingerprint: first });
    expect((await store.remove({ target: { ...target, port: 2222 }, hostKeyFingerprint: first })).data).toMatchObject({ removed: false });
    expect((await store.remove({ target, hostKeyFingerprint: changed })).data).toMatchObject({ removed: false });
    expect((await store.remove({ target, hostKeyFingerprint: first })).data).toMatchObject({ removed: true });
    expect((await store.inspect({ target, observedFingerprint: first })).data).toEqual({ state: "unknown" });
  });

  test("corrupt, extra-key, oversize, and cross-instance bytes fail closed without replacement", async () => {
    const valid = { version: 1, host: target.host, port: 22, hostKeyFingerprint: first, confirmedAt: clock().toISOString() };
    const invalid = [
      "{not-json",
      JSON.stringify({ version: 1, instanceId: "other-instance", revision: 0, records: [], updatedAt: clock().toISOString() }),
      JSON.stringify({ version: 1, instanceId: "nautilo-instance-1", revision: 0, records: [{ ...valid, extra: true }], updatedAt: clock().toISOString() }),
      JSON.stringify({ version: 1, instanceId: "nautilo-instance-1", revision: 0, records: Array.from({ length: 129 }, () => valid), updatedAt: clock().toISOString() }),
    ];
    for (const raw of invalid) {
      const memory = memoryStorage(raw);
      const { store } = makeStore(memory);
      expect((await store.lookup({ target })).ok).toBe(false);
      expect((await store.inspect({ target, observedFingerprint: first })).ok).toBe(false);
      expect((await store.confirm({ target, hostKeyFingerprint: first })).ok).toBe(false);
      expect(memory.writes()).toBe(0);
      expect(memory.bytes()).toBe(raw);
    }
  });

  test("rejects noncanonical hosts, malformed fingerprints, and finite-bound violations", async () => {
    const { store } = makeStore();
    expect(await store.confirm({ target: { ...target, host: "Build.Example.Test" }, hostKeyFingerprint: first })).toMatchObject({ ok: false, code: "invalid_record" });
    expect(await store.confirm({ target: { ...target, port: 65536 }, hostKeyFingerprint: first })).toMatchObject({ ok: false, code: "invalid_record" });
    expect(await store.confirm({ target, hostKeyFingerprint: "not a fingerprint" })).toMatchObject({ ok: false, code: "invalid_record" });
  });

  test("keeps bounded inactive replacement history while retaining the active trust", async () => {
    const { store, memory } = makeStore();
    let fingerprint = first;
    await store.confirm({ target, hostKeyFingerprint: fingerprint });
    for (let index = 0; index < 140; index += 1) {
      const next = `SHA256:replacement-${String(index).padStart(43, "x")}`;
      expect((await store.replace({ target, previousFingerprint: fingerprint, nextFingerprint: next })).ok).toBe(true);
      fingerprint = next;
    }
    const persisted = JSON.parse(memory.bytes() ?? "{}");
    expect(persisted.records).toHaveLength(128);
    expect((await store.inspect({ target, observedFingerprint: fingerprint })).data).toMatchObject({ state: "trusted" });
  });

  test("storage failures are typed and secret-free", async () => {
    const readFailure = new SshHostTrustStore({ instanceId: "nautilo-instance-1", filePath: "/unused", storage: { read: async () => { throw new Error("private /secret/path"); }, writeAtomic: async () => undefined } });
    expect(await readFailure.inspect({ target, observedFingerprint: first })).toEqual({ ok: false, code: "store_unavailable", message: "structured SSH host trust could not be read" });
    const writeFailure = new SshHostTrustStore({ instanceId: "nautilo-instance-1", filePath: "/unused", storage: { read: async () => null, writeAtomic: async () => { throw new Error("private /secret/path"); } } });
    expect(await writeFailure.confirm({ target, hostKeyFingerprint: first })).toEqual({ ok: false, code: "store_unavailable", message: "structured SSH host trust could not be persisted" });
  });
});
