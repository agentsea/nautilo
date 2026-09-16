import { afterEach, describe, expect, test } from "bun:test";
import {
  ColdBootObservationAuthority,
  type ColdBootDiagnostic,
} from "../../electron/cold-boot-observation";

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop();
});

function healthBody(identity = "expected"): Record<string, unknown> {
  return { status: "ok", serverIdentity: identity };
}

function startHealthServer(
  responses: Array<{
    delayMs?: number;
    status?: number;
    body?: unknown;
    invalidJson?: boolean;
  }>,
): string {
  let index = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/health") {
        return new Response("not found", { status: 404 });
      }
      const next = responses[Math.min(index++, responses.length - 1)] ?? {};
      if (next.delayMs) await Bun.sleep(next.delayMs);
      if (next.invalidJson) {
        return new Response("not json", {
          status: next.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(next.body ?? healthBody()), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function authority(
  diagnostics: ColdBootDiagnostic[] = [],
  expected = "expected",
): ColdBootObservationAuthority {
  return new ColdBootObservationAuthority({
    fetch: (input, init) => fetch(input, init),
    expectedFingerprint: () => expected,
    fingerprintFromHealthBody: (body) =>
      typeof body.serverIdentity === "string" ? body.serverIdentity : null,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
}

describe("D514 cold-boot health observation", () => {
  test("a promoted connection cohort changes the previously connecting bootstrap snapshot to live without a second fetch", () => {
    let fetches = 0;
    const observer = new ColdBootObservationAuthority({
      fetch: async () => {
        fetches += 1;
        return { ok: true, json: async () => healthBody() };
      },
      expectedFingerprint: () => "fingerprint-b",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? `fingerprint-${body.serverIdentity}` : null,
    });
    const cohort = {
      serverUrl: "https://b.example.test",
      healthBody: { status: "ok", serverIdentity: "b" },
      fingerprint: "fingerprint-b",
    };

    // This is the first-run failure shape: promotion already succeeded in the
    // connection flow, while bootstrap IPC would otherwise read this default.
    expect(observer.snapshot()).toEqual({
      kind: "connecting",
      generation: 0,
      serverUrl: null,
    });

    expect(observer.projectVerifiedCohort(cohort)).toEqual({
      kind: "live",
      generation: 1,
      serverUrl: cohort.serverUrl,
      healthBody: cohort.healthBody,
    });
    expect(observer.snapshot().kind).toBe("live");
    expect(observer.attemptSnapshot()).toBeNull();
    expect(fetches).toBe(0);
  });

  test("durable-eligible attempt ids do not alias at the same generation across launches", async () => {
    const serverUrl = startHealthServer([
      { body: healthBody() },
      { body: healthBody() },
    ]);
    const make = (id: string) => new ColdBootObservationAuthority({
      fetch: (input, init) => fetch(input, init),
      expectedFingerprint: () => "expected",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? body.serverIdentity : null,
      mintAttemptId: () => id,
    });
    const first = make("launch-one-attempt");
    const second = make("launch-two-attempt");
    await first.observe(serverUrl);
    await second.observe(serverUrl);
    expect(first.attemptSnapshot()?.generation).toBe(1);
    expect(second.attemptSnapshot()?.generation).toBe(1);
    expect(first.attemptSnapshot()?.attemptId).not.toBe(second.attemptSnapshot()?.attemptId);
  });

  for (const delayMs of [801, 1_500, 2_500]) {
    test(`actual /health success after ${delayMs}ms stays live`, async () => {
      const serverUrl = startHealthServer([{ delayMs, body: healthBody() }]);
      const observed = await authority().observe(serverUrl);
      expect(observed.kind).toBe("live");
      if (observed.kind === "live") expect(observed.serverUrl).toBe(serverUrl);
    });
  }

  test("malformed JSON and missing identity fail closed as malformed", async () => {
    const invalidJson = await authority().observe(
      startHealthServer([{ invalidJson: true }]),
    );
    expect(invalidJson.kind).toBe("malformed");

    const missingIdentity = await authority().observe(
      startHealthServer([{ body: { status: "ok" } }]),
    );
    expect(missingIdentity.kind).toBe("malformed");
  });

  test("wrong identity remains distinct until its displayed identity is freshly re-proved", async () => {
    const observer = authority([], "expected");
    const serverUrl = startHealthServer([
      { body: healthBody("observed") },
      { body: healthBody("observed") },
    ]);
    const displayed = await observer.observe(serverUrl);
    expect(displayed.kind).toBe("wrong-server");
    if (displayed.kind === "wrong-server") {
      expect(displayed.expectedFingerprint).toBe("expected");
      expect(displayed.observedFingerprint).toBe("observed");
    }
    const observed = await observer.observe(serverUrl, {
      forceFresh: true,
      acceptDisplayedWrongServer: displayed as Extract<typeof displayed, { kind: "wrong-server" }>,
    });
    expect(observed.kind).toBe("acceptance-proof");
    expect(observer.snapshot()).toEqual(displayed);
    expect(observer.attemptSnapshot()?.phase).toBe("setup");
    expect(observer.attemptSnapshot()?.facts.acceptedMismatch?.observedIdentity).toBe("observed");
    if (observed.kind === "acceptance-proof") {
      expect(observer.commitAcceptedWrongServer(observed).kind).toBe("live");
    }
  });

  test("use-anyway accepts B only when one fresh B response proves it, never B-to-C", async () => {
    const observer = authority([], "expected");
    const sameIdentityServer = startHealthServer([
      { body: healthBody("B") },
      { body: healthBody("B") },
    ]);
    const displayed = await observer.observe(sameIdentityServer);
    expect(displayed.kind).toBe("wrong-server");
    const accepted = await observer.observe(sameIdentityServer, {
      forceFresh: true,
      acceptDisplayedWrongServer: displayed as Extract<typeof displayed, { kind: "wrong-server" }>,
    });
    expect(accepted.kind).toBe("acceptance-proof");
    expect(observer.snapshot()).toEqual(displayed);
    expect(observer.attemptSnapshot()).toMatchObject({ phase: "setup", generation: 2 });
    if (accepted.kind === "acceptance-proof") {
      expect(observer.commitAcceptedWrongServer(accepted).kind).toBe("live");
    }

    const changedObserver = authority([], "expected");
    const changedServer = startHealthServer([
      { body: healthBody("B") },
      { body: healthBody("C") },
    ]);
    const displayedB = await changedObserver.observe(changedServer);
    const freshC = await changedObserver.observe(changedServer, {
      forceFresh: true,
      acceptDisplayedWrongServer: displayedB as Extract<typeof displayedB, { kind: "wrong-server" }>,
    });
    expect(freshC.kind).toBe("wrong-server");
    if (freshC.kind === "wrong-server") {
      // B is the signed-off identity; C needs a new explicit decision.
      expect(freshC.expectedFingerprint).toBe("B");
      expect(freshC.observedFingerprint).toBe("C");
    }
    expect(changedObserver.attemptSnapshot()?.phase).toBe("mismatch");
  });

  test("a provisional B proof cannot release a coalesced retry and rollback makes the next click complete", async () => {
    let releaseFresh: (() => void) | null = null;
    const freshWait = new Promise<void>((resolve) => { releaseFresh = resolve; });
    let calls = 0;
    const observer = new ColdBootObservationAuthority({
      fetch: async () => {
        calls += 1;
        if (calls === 2) await freshWait;
        return { ok: true, json: async () => healthBody("B") };
      },
      expectedFingerprint: () => "expected",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? body.serverIdentity : null,
    });
    const serverUrl = "https://accepted.example.test";
    const displayed = await observer.observe(serverUrl);
    expect(displayed.kind).toBe("wrong-server");
    const proofRequest = observer.observe(serverUrl, {
      forceFresh: true,
      acceptDisplayedWrongServer: displayed as Extract<typeof displayed, { kind: "wrong-server" }>,
    });
    const coalescedRetry = observer.observe(serverUrl);
    releaseFresh?.();
    const [proof, retryResult] = await Promise.all([proofRequest, coalescedRetry]);
    expect(proof.kind).toBe("acceptance-proof");
    expect(retryResult.kind).toBe("acceptance-proof");
    expect(observer.snapshot()).toEqual(displayed);
    if (proof.kind !== "acceptance-proof") throw new Error("expected acceptance proof");

    // Simulates fingerprint persistence throwing before the synchronous commit.
    expect(observer.rollbackAcceptedWrongServer(proof)).toEqual(displayed);
    expect(observer.attemptSnapshot()?.phase).toBe("mismatch");
    const retriedProof = await observer.observe(serverUrl, {
      forceFresh: true,
      acceptDisplayedWrongServer: displayed as Extract<typeof displayed, { kind: "wrong-server" }>,
    });
    expect(retriedProof.kind).toBe("acceptance-proof");
    if (retriedProof.kind === "acceptance-proof") {
      expect(observer.commitAcceptedWrongServer(retriedProof).kind).toBe("live");
    }
  });

  test("a stale provisional proof cannot commit after another observation replaces it", async () => {
    const observer = authority([], "expected");
    const serverUrl = startHealthServer([
      { body: healthBody("B") },
      { body: healthBody("B") },
      { body: healthBody("B") },
    ]);
    const displayed = await observer.observe(serverUrl);
    const proof = await observer.observe(serverUrl, {
      forceFresh: true,
      acceptDisplayedWrongServer: displayed as Extract<typeof displayed, { kind: "wrong-server" }>,
    });
    expect(proof.kind).toBe("acceptance-proof");
    await observer.observe(serverUrl, { forceFresh: true });
    if (proof.kind === "acceptance-proof") {
      expect(observer.commitAcceptedWrongServer(proof).kind).not.toBe("live");
    }
  });

  test("legacy scoped persisted URLs preserve their health base while receipts stay origin-bound", async () => {
    const requests: string[] = [];
    const observer = new ColdBootObservationAuthority({
      fetch: async (input) => {
        requests.push(input);
        return { ok: true, json: async () => healthBody() };
      },
      expectedFingerprint: () => "expected",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? body.serverIdentity : null,
    });
    const observed = await observer.observe("https://legacy.example.test/nautilo");
    expect(observed.kind).toBe("live");
    expect(requests).toEqual(["https://legacy.example.test/nautilo/health"]);
    expect(observer.attemptSnapshot()?.facts.health?.origin).toBe("https://legacy.example.test");
  });

  test("a bare persisted host probes the selected HTTPS origin, never a schemeless URL", async () => {
    const requests: string[] = [];
    const observer = new ColdBootObservationAuthority({
      fetch: async (input) => {
        requests.push(input);
        return { ok: true, json: async () => healthBody() };
      },
      expectedFingerprint: () => "expected",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? body.serverIdentity : null,
    });
    expect((await observer.observe("alpha.example.test")).kind).toBe("live");
    expect(requests).toEqual(["https://alpha.example.test/health"]);
  });

  /*
   * The typed wrong-server observation exposes only the explicit comparison;
   * raw health material remains main-private.
   */
  test("wrong identity exposes only the explicit trust comparison", async () => {
    const observer = authority([], "expected");
    const observed = await observer.observe(
      startHealthServer([{ body: healthBody("observed") }]),
    );
    expect(observed.kind).toBe("wrong-server");
    if (observed.kind === "wrong-server") {
      expect(observed.expectedFingerprint).toBe("expected");
      expect(observed.observedFingerprint).toBe("observed");
    }
  });

  test("a transient unavailable result recovers to live on the next main-owned observation", async () => {
    const serverUrl = startHealthServer([
      { status: 503 },
      { body: healthBody() },
    ]);
    const observer = authority();
    expect((await observer.observe(serverUrl)).kind).toBe("unavailable");
    expect((await observer.observe(serverUrl)).kind).toBe("live");
  });

  test("cancellation and supersession prevent a late old health result becoming current truth", async () => {
    let releaseFirst: (() => void) | null = null;
    const waitFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const diagnostics: ColdBootDiagnostic[] = [];
    const observer = new ColdBootObservationAuthority({
      fetch: async () => {
        calls += 1;
        if (calls === 1) await waitFirst;
        return { ok: true, json: async () => healthBody(calls === 1 ? "old" : "expected") };
      },
      expectedFingerprint: () => "expected",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? body.serverIdentity : null,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const old = observer.observe("https://old.example.test");
    observer.cancel();
    releaseFirst?.();
    await old;
    expect(observer.snapshot()).toMatchObject({ kind: "unavailable", serverUrl: "https://old.example.test" });
    expect(observer.attemptSnapshot()?.phase).toBe("cancelled");
    expect(diagnostics.map((d) => d.category)).toContain("cancelled");
    expect(diagnostics.map((d) => d.category)).not.toContain("network");

    const oldAgain = observer.observe("https://old.example.test");
    const replacement = observer.observe("https://new.example.test");
    await Promise.all([oldAgain, replacement]);
    const current = observer.snapshot();
    expect(current.kind).toBe("live");
    if (current.kind === "live") expect(current.serverUrl).toBe("https://new.example.test");
    expect(diagnostics.map((d) => d.category)).toContain("superseded");
  });

  test("an outstanding /health remains connecting past the former 5002ms ceiling and then succeeds", async () => {
    let release: (() => void) | null = null;
    const request = new Promise<void>((resolve) => { release = resolve; });
    let now = 0;
    const diagnostics: ColdBootDiagnostic[] = [];
    const observer = new ColdBootObservationAuthority({
      fetch: async () => {
        await request;
        return { ok: true, json: async () => healthBody() };
      },
      expectedFingerprint: () => "expected",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? body.serverIdentity : null,
      now: () => now,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
        throw new Error("diagnostic sink failed");
      },
    });
    const observed = observer.observe("https://slow.example.test");
    now = 5_002;
    expect(observer.snapshot()).toMatchObject({ kind: "connecting", generation: 1 });
    expect(observer.attemptSnapshot()).toMatchObject({
      generation: 1,
      context: "cold-boot",
      phase: "transport",
    });
    release?.();
    expect((await observed).kind).toBe("live");
    expect(diagnostics.map((diagnostic) => diagnostic.category)).toContain("verified");
    expect(diagnostics.map((diagnostic) => diagnostic.category)).not.toContain("timeout");
  });

  test("a body-stalled health response can be cancelled and retried without late authority or diagnostic leakage", async () => {
    let releaseBody: (() => void) | null = null;
    const stalledBody = new Promise<void>((resolve) => { releaseBody = resolve; });
    let bodyStarted = false;
    let calls = 0;
    const diagnostics: ColdBootDiagnostic[] = [];
    const serverUrl = "https://body-stall.example.test";
    const observer = new ColdBootObservationAuthority({
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            url: `${serverUrl}/health`,
            json: async () => {
              bodyStarted = true;
              await stalledBody;
              return {
                status: "ok",
                serverIdentity: "body-stall-identity-secret",
                providerBody: "body-stall-provider-secret",
              };
            },
          };
        }
        return {
          ok: true,
          url: `${serverUrl}/health`,
          json: async () => healthBody(),
        };
      },
      expectedFingerprint: () => "expected",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? body.serverIdentity : null,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const stalled = observer.observe(serverUrl);
    for (let turn = 0; turn < 4 && !bodyStarted; turn += 1) await Promise.resolve();
    expect(bodyStarted).toBe(true);
    expect(observer.snapshot()).toMatchObject({ kind: "connecting", generation: 1, serverUrl });
    expect(observer.attemptSnapshot()?.phase).toBe("health");

    observer.cancel();
    const retried = await observer.observe(serverUrl);
    expect(retried.kind).toBe("live");
    expect(observer.snapshot()).toMatchObject({ kind: "live", generation: 2, serverUrl });

    releaseBody?.();
    await stalled;
    expect(observer.snapshot()).toMatchObject({ kind: "live", generation: 2, serverUrl });
    expect(diagnostics.map((diagnostic) => diagnostic.category)).toEqual([
      "connecting", "cancelled", "connecting", "verified",
    ]);
    const rendered = JSON.stringify(diagnostics);
    for (const forbidden of [serverUrl, "body-stall-identity-secret", "body-stall-provider-secret"]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  test("the connection-attempt receipt fences a redirected or late origin", async () => {
    const observer = new ColdBootObservationAuthority({
      fetch: async () => ({
        ok: true,
        url: "https://other.example.test/health",
        json: async () => healthBody(),
      }),
      expectedFingerprint: () => "expected",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? body.serverIdentity : null,
    });
    const observed = await observer.observe("https://expected.example.test");
    expect(observed.kind).toBe("unavailable");
    expect(observer.attemptSnapshot()).toMatchObject({
      generation: 1,
      context: "cold-boot",
      phase: "failed",
    });
  });

  test("diagnostics use only stable phase/category/duration fields and never contain raw content", async () => {
    const diagnostics: ColdBootDiagnostic[] = [];
    const secretUrl = "https://server.example.test";
    const secretBody = {
      status: "ok",
      serverIdentity: "raw-fingerprint",
      token: "bearer-secret",
      certificate: "certificate-detail",
      providerBody: "private-response",
    };
    const observer = new ColdBootObservationAuthority({
      fetch: async () => ({ ok: true, json: async () => secretBody }),
      expectedFingerprint: () => "raw-fingerprint",
      fingerprintFromHealthBody: (body) =>
        typeof body.serverIdentity === "string" ? body.serverIdentity : null,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await observer.observe(secretUrl);
    expect(diagnostics.some((d) => d.phase === "health" && d.category === "verified")).toBe(true);
    const rendered = JSON.stringify(diagnostics);
    for (const forbidden of ["server.example", "top-secret", "raw-fingerprint", "bearer-secret", "certificate-detail", "private-response"]) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});
