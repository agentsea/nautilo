import { describe, expect, test } from "bun:test";
import { BolterCliClient, type BolterCliClientOptions } from "../../electron/bolter-bridge/cli-client";
import type { BolterCliInvocation, BolterCliRuntime, BolterQualifiedDecoders } from "../../electron/bolter-bridge/cli-contract";

const runtime: BolterCliRuntime = {
  executable: "/opt/nautilo/bolter-agent", home: "/var/lib/nautilo/connection",
  platform: "linux", version: "synthetic-cli-v1",
};
const selection = { origin: "https://bolter.chat", agentId: "synthetic-agent", cliSelector: "synthetic-agent" };
const binding = { chatId: "synthetic-chat", threadRootId: "synthetic-root" };
const receipt = { ...binding, messageId: "synthetic-published-message" };
// These fixtures deliberately describe only the adapter's internal normalized format.
const decoders: BolterQualifiedDecoders = {
  version: runtime.version, identity: (raw) => raw, receipt: (raw) => raw,
  authLink: (stdout) => JSON.parse(stdout) as unknown,
};
function fixture(overrides: Partial<BolterCliClientOptions> = {}) {
  const calls: BolterCliInvocation[] = [];
  const client = new BolterCliClient({ runtime, decoders, isCurrent: () => true,
    attest: () => Promise.resolve(true), execute: (plan) => {
      calls.push(plan);
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" });
    }, ...overrides });
  return { client, calls };
}

describe("attested fixed CLI client", () => {
  test("sends once and records a matching qualified receipt", async () => {
    const { client, calls } = fixture();
    expect(await client.send(selection, binding, "Synthetic reply")).toEqual({ status: "sent", receipt });
    expect(calls.length).toBe(1);
    expect(calls[0]?.stdin).toBe('{"content":"Synthetic reply"}');
  });

  test("rejects absent or mismatched receipt decoder before publication", async () => {
    for (const candidate of [undefined, { ...decoders, version: "other" }, { version: runtime.version }]) {
      const { client, calls } = fixture({ decoders: candidate });
      expect(await client.send(selection, binding, "Text")).toEqual({ status: "unavailable", reason: "unsupported-output" });
      expect(calls.length).toBe(0);
    }
  });

  test("current authority is checked before and after asynchronous attestation", async () => {
    let current = true;
    const { client, calls } = fixture({ isCurrent: () => current,
      attest: () => { current = false; return Promise.resolve(true); } });
    expect(await client.send(selection, binding, "Text")).toEqual({ status: "unavailable", reason: "stale-authority" });
    expect(calls.length).toBe(0);
    const rejected = fixture({ attest: () => Promise.resolve(false) });
    expect(await rejected.client.send(selection, binding, "Text")).toEqual({ status: "unavailable", reason: "attestation-failed" });
    expect(rejected.calls.length).toBe(0);
  });

  test("attestation exceptions contain no raw diagnostic output", async () => {
    const { client, calls } = fixture({ attest: () => Promise.reject(new Error("synthetic secret")) });
    expect(await client.send(selection, binding, "Text")).toEqual({ status: "unavailable", reason: "attestation-failed" });
    expect(calls.length).toBe(0);
  });

  test("revocation between async admission and execution stops sends and identity reads", async () => {
    for (const operation of ["send", "identity"] as const) {
      let current = true;
      let checks = 0;
      const { client, calls } = fixture({ isCurrent: () => {
        checks++;
        if (checks === 2) queueMicrotask(() => { current = false; });
        return current;
      } });
      const outcome = operation === "send" ? await client.send(selection, binding, "Text") :
        await client.confirmIdentity(selection);
      expect(outcome).toEqual({ status: "unavailable", reason: "stale-authority" });
      expect(calls.length).toBe(0);
    }
  });

  test("a failed authority callback never dispatches or exposes its diagnostic", async () => {
    const { client, calls } = fixture({ isCurrent: () => { throw new Error("synthetic secret"); } });
    expect(await client.send(selection, binding, "Text")).toEqual({ status: "unavailable", reason: "stale-authority" });
    expect(calls.length).toBe(0);
  });

  test("all ambiguous sends stay uncertain and never retry", async () => {
    for (const response of [
      { exitCode: null, stdout: "", stderr: "synthetic secret" },
      { exitCode: 1, stdout: JSON.stringify(receipt), stderr: "synthetic secret" },
      { exitCode: 0, stdout: "unobserved result", stderr: "synthetic secret" },
      { exitCode: 0, stdout: JSON.stringify({ ...receipt, chatId: "other-chat" }), stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ ...receipt, threadRootId: null }), stderr: "" },
    ]) {
      let count = 0;
      const { client } = fixture({ execute: () => { count++; return Promise.resolve(response); } });
      const outcome = await client.send(selection, binding, "Text");
      expect(outcome.status).toBe("uncertain");
      expect(JSON.stringify(outcome)).not.toContain("synthetic secret");
      expect(count).toBe(1);
    }
    let count = 0;
    const { client } = fixture({ execute: () => { count++; return Promise.reject(new Error("synthetic secret")); } });
    expect(await client.send(selection, binding, "Text")).toEqual({ status: "uncertain", reason: "execution-failed" });
    expect(count).toBe(1);
  });

  test("revocation after execution and mutation of caller inputs cannot retarget receipts", async () => {
    let current = true;
    const localBinding = { ...binding };
    const { client } = fixture({ isCurrent: () => current, execute: () => {
      current = false;
      localBinding.chatId = "other-chat";
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" });
    } });
    expect(await client.send(selection, localBinding, "Text")).toEqual({ status: "uncertain", reason: "stale-authority" });
  });
});

describe("authentication is separate from identity confirmation", () => {
  test("qualified link parsing exposes only validated link and code", () => {
    const { client } = fixture();
    expect(client.decodeAuthLink(JSON.stringify({ url: "https://bolter.chat/verify?request=synthetic", code: "BCDF-GHJK", token: "discard" })))
      .toEqual({ ok: true, value: { url: "https://bolter.chat/verify?request=synthetic", code: "BCDF-GHJK" } });
    expect(client.decodeAuthLink("Setup is done")).toEqual({ ok: false, reason: "unsupported-output" });
    expect(fixture({ decoders: undefined }).client.decodeAuthLink("anything").ok).toBe(false);
  });

  test("identity needs an exact origin/agent match after successful decoded JSON", async () => {
    for (const identity of [selection, { ...selection, agentId: "other-agent" }, { ...selection, origin: "https://other.example" }]) {
      const { client } = fixture({ execute: () => Promise.resolve({ exitCode: 0, stdout: JSON.stringify(identity), stderr: "" }) });
      expect((await client.confirmIdentity(selection)).status).toBe(identity === selection ? "confirmed" : "unavailable");
    }
    const { client } = fixture({ execute: () => Promise.resolve({ exitCode: 0, stdout: "Connected", stderr: "synthetic secret" }) });
    expect(await client.confirmIdentity(selection)).toEqual({ status: "unavailable", reason: "unsupported-output" });
  });
});
