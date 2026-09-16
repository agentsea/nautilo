import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { bundledApplicationCatalogue } from "../../src/config/application-catalogue/catalog";
import {
  configureRuntimeApplicationCatalogue,
  getActiveApplicationCatalogueResultSync,
  kickRuntimeApplicationCatalogueRefresh,
  refreshRuntimeApplicationCatalogue,
  resetRuntimeApplicationCatalogue,
} from "../../src/config/application-catalogue/runtime-catalogue";
import { createRemoteApplicationCatalogueLoader } from "../../src/config/application-catalogue/remote-catalogue";
import { canonicalApplicationCatalogueSigningPayloadV1 } from "@nautilo/types";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function nextCatalogueVersion(after = bundledApplicationCatalogue.catalogueVersion): string {
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/u.exec(after);
  if (!match) throw new Error("invalid bundled catalogue version fixture");
  return `${match[1]}.${Number(match[2]) + 1}`;
}

function nextPublishedAt(): string {
  return new Date(Date.parse(bundledApplicationCatalogue.publishedAt) + 60 * 60 * 1000).toISOString();
}

function signedFixture(
  catalogueVersion = nextCatalogueVersion(),
  publishedAt = nextPublishedAt(),
  mutate?: (snapshot: Record<string, unknown>) => void,
  signing?: { publicKey: KeyObject; privateKey: KeyObject },
) {
  const { publicKey, privateKey } = signing ?? generateKeyPairSync("ed25519");
  const snapshot: Record<string, unknown> = {
    ...bundledApplicationCatalogue,
    catalogueVersion,
    provenance: undefined,
    publishedAt,
  };
  delete snapshot["provenance"];
  mutate?.(snapshot);
  const text = JSON.stringify(snapshot);
  const hash = createHash("sha256").update(text).digest("hex");
  const pointer = {
    catalogueVersion,
    artifactSha256: hash,
    signingKeyId: "test",
    signature: sign(
      null,
      Buffer.from(canonicalApplicationCatalogueSigningPayloadV1(catalogueVersion, hash)),
      privateKey,
    ).toString("base64"),
  };
  return {
    snapshot,
    pointer,
    key: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    signing: { publicKey, privateKey },
  };
}

function releaseFetch(pointer: unknown, artifact: unknown): typeof fetch {
  let request = 0;
  return (async () => json(request++ === 0 ? pointer : artifact)) as unknown as typeof fetch;
}

function loaderFor(fixture: ReturnType<typeof signedFixture>, fetchImpl = releaseFetch(fixture.pointer, fixture.snapshot)) {
  return createRemoteApplicationCatalogueLoader({
    pointerUrl: "https://Example.TEST/latest.json",
    trustedKeys: { test: fixture.key },
    fetchImpl,
  });
}

test("valid signed application metadata refreshes exact installed IDs with remote provenance", async () => {
  const fixture = signedFixture();
  const result = await createRemoteApplicationCatalogueLoader({
    pointerUrl: "https://Example.TEST/latest.json",
    allowedHosts: ["EXAMPLE.TEST"],
    trustedKeys: { test: fixture.key },
    fetchImpl: releaseFetch(fixture.pointer, fixture.snapshot),
  }).refresh();

  expect(result.source).toBe("remote-fresh");
  expect(result.catalogue.provenance).toBe("remote");
  expect(result.catalogue.targets.map((entry) => entry.target))
    .toEqual(bundledApplicationCatalogue.targets.map((entry) => entry.target));
});

test("signature, hash, schema, version, and exact target-set failures never activate", async () => {
  const fixture = signedFixture();
  const badHash = { ...fixture.pointer, artifactSha256: "b".repeat(64) };
  const cases: Array<[unknown, unknown]> = [
    [{ ...fixture.pointer, signature: "A".repeat(86) + "==" }, fixture.snapshot],
    [badHash, fixture.snapshot],
    [fixture.pointer, { ...fixture.snapshot, executable: "route" }],
    [fixture.pointer, { ...fixture.snapshot, targets: (fixture.snapshot["targets"] as unknown[]).slice(1) }],
    [{ ...fixture.pointer, catalogueVersion: "2026-08-12.3" }, fixture.snapshot],
  ];

  for (const [pointer, artifact] of cases) {
    expect((await loaderFor(fixture, releaseFetch(pointer, artifact)).refresh()).source)
      .toBe("checked-in-fallback");
  }
  expect((await createRemoteApplicationCatalogueLoader({
    pointerUrl: "https://example.test/latest.json",
    fetchImpl: releaseFetch({ ...fixture.pointer, signingKeyId: "unknown-key" }, fixture.snapshot),
  }).refresh()).source).toBe("checked-in-fallback");
});

test("release transport rejects unsafe URLs and malformed responses without echoing details", async () => {
  const unsafeUrls = [
    "http://example.test/latest.json",
    "https://user:pass@example.test/latest.json",
    "https://example.test/latest.json?token=x",
    "https://example.test/latest.json#fragment",
    "https://127.0.0.1/latest.json",
    "https://[::1]/latest.json",
    "https://[::ffff:127.0.0.1]/latest.json",
    "https://[::127.0.0.1]/latest.json",
    "https://[fe80::1]/latest.json",
    "https://[fd00::1]/latest.json",
    "not a url",
  ];
  for (const pointerUrl of unsafeUrls) {
    const result = await createRemoteApplicationCatalogueLoader({
      pointerUrl,
      fetchImpl: (async () => { throw new Error("network secret"); }) as unknown as typeof fetch,
    }).refresh();
    expect(result.source).toBe("checked-in-fallback");
    expect(result.reason).not.toContain("secret");
  }

  const fixture = signedFixture();
  for (const response of [
    new Response("no", { status: 500 }),
    new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
    new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "9999999" } }),
    new Response(new Uint8Array([0xc3, 0x28]), { status: 200, headers: { "content-type": "application/json" } }),
    new Response("{}", { status: 302, headers: { "content-type": "application/json" } }),
  ]) {
    const result = await loaderFor(fixture, (async () => response) as unknown as typeof fetch).refresh();
    expect(result.source).toBe("checked-in-fallback");
  }
});

test("absolute timeout covers a noncompliant fetch and a slow response body", async () => {
  const fixture = signedFixture();
  const never = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  const timedOut = await createRemoteApplicationCatalogueLoader({
    pointerUrl: "https://example.test/latest.json",
    trustedKeys: { test: fixture.key },
    fetchImpl: never,
    timeoutMs: 5,
  }).refresh();
  expect(timedOut.source).toBe("checked-in-fallback");

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      setTimeout(() => controller.enqueue(new TextEncoder().encode("}")), 30);
    },
  });
  const slow = await createRemoteApplicationCatalogueLoader({
    pointerUrl: "https://example.test/latest.json",
    trustedKeys: { test: fixture.key },
    timeoutMs: 5,
    fetchImpl: (async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
  }).refresh();
  expect(slow.source).toBe("checked-in-fallback");
});

test("remote cache is single-flight, uses ttl plus stale horizon, and retains LKG", async () => {
  const fixture = signedFixture();
  let calls = 0;
  let now = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls <= 2) return json(calls === 1 ? fixture.pointer : fixture.snapshot);
    throw new Error("offline secret");
  }) as unknown as typeof fetch;
  const loader = createRemoteApplicationCatalogueLoader({
    pointerUrl: "https://example.test/latest.json",
    trustedKeys: { test: fixture.key },
    fetchImpl,
    now: () => now,
    ttlMs: 10,
    staleMs: 10,
  });
  const [first, second] = await Promise.all([loader.refresh(), loader.refresh()]);
  expect(first.source).toBe("remote-fresh");
  expect(second.source).toBe("remote-fresh");
  expect(calls).toBe(2);

  now = 5;
  expect((await loader.get()).source).toBe("remote-fresh");
  now = 11;
  expect((await loader.get()).source).toBe("remote-stale");
  await Promise.resolve();
  now = 21;
  expect((await loader.get()).source).toBe("remote-stale");
  expect(calls).toBeGreaterThanOrEqual(3);
  now = -1;
  const clockRejected = await loader.get();
  expect(clockRejected.source).toBe("remote-stale");
  expect(clockRejected.reason).toBe("application catalogue clock rejected");
});

test("an unchanged signed release revalidates, renews freshness, and rejects invalid config bounds early", async () => {
  const fixture = signedFixture();
  let now = 0;
  let calls = 0;
  const loader = createRemoteApplicationCatalogueLoader({
    pointerUrl: "https://example.test/latest.json",
    trustedKeys: { test: fixture.key },
    now: () => now,
    ttlMs: 10,
    staleMs: 10,
    fetchImpl: (async () => json(calls++ % 2 === 0 ? fixture.pointer : fixture.snapshot)) as unknown as typeof fetch,
  });
  expect((await loader.refresh()).source).toBe("remote-fresh");
  now = 11;
  expect((await loader.refresh()).source).toBe("remote-fresh");
  now = 20;
  expect((await loader.get()).source).toBe("remote-fresh");
  expect(calls).toBe(4);

  for (const config of [
    { maxBytes: 4 * 1024 * 1024 + 1 },
    { timeoutMs: 60_001 },
    { ttlMs: 30 * 24 * 60 * 60 * 1000 + 1 },
    { staleMs: 30 * 24 * 60 * 60 * 1000 + 1 },
  ]) {
    expect(() => createRemoteApplicationCatalogueLoader(config)).toThrow("application catalogue config bounds rejected");
  }
});

test("rollback, version monotonicity, and immutable version conflicts retain LKG", async () => {
  const equalToBundled = signedFixture(
    bundledApplicationCatalogue.catalogueVersion,
    bundledApplicationCatalogue.publishedAt,
  );
  expect((await loaderFor(equalToBundled).refresh()).source).toBe("checked-in-fallback");

  const firstVersion = nextCatalogueVersion();
  const firstPublishedAt = nextPublishedAt();
  const laterPublishedAt = new Date(Date.parse(firstPublishedAt) + 60 * 60 * 1000).toISOString();
  const first = signedFixture(firstVersion, firstPublishedAt);
  const lowerVersion = signedFixture(bundledApplicationCatalogue.catalogueVersion, laterPublishedAt, undefined, first.signing);
  const sameVersion = signedFixture(firstVersion, laterPublishedAt, (snapshot) => {
    snapshot["targets"] = (snapshot["targets"] as Array<Record<string, unknown>>).map((target) => target["target"] === "connections.ssh"
      ? { ...target, label: "Conflicting SSH" }
      : target);
  }, first.signing);
  const sameTimeConflict = signedFixture(nextCatalogueVersion(firstVersion), firstPublishedAt, undefined, first.signing);
  const responses = [
    first.pointer, first.snapshot,
    lowerVersion.pointer, lowerVersion.snapshot,
    sameVersion.pointer, sameVersion.snapshot,
    sameTimeConflict.pointer, sameTimeConflict.snapshot,
  ];
  let index = 0;
  const loader = createRemoteApplicationCatalogueLoader({
    pointerUrl: "https://example.test/latest.json",
    trustedKeys: { test: first.key },
    fetchImpl: (async () => json(responses[index++])) as unknown as typeof fetch,
  });
  expect((await loader.refresh()).source).toBe("remote-fresh");
  expect((await loader.refresh()).source).toBe("remote-stale");
  expect((await loader.refresh()).source).toBe("remote-stale");
  expect((await loader.refresh()).source).toBe("remote-stale");
});

test("disabled application catalogue refresh makes no network request and serves bundled fallback", async () => {
  let calls = 0;
  const loader = createRemoteApplicationCatalogueLoader({
    fetchImpl: (async () => { calls += 1; throw new Error("must not fetch"); }) as unknown as typeof fetch,
  });
  const result = await loader.get();
  expect(calls).toBe(0);
  expect(result.catalogue).toEqual(bundledApplicationCatalogue);
  expect(result.catalogueVersion).toBe(bundledApplicationCatalogue.catalogueVersion);
  expect(result.source).toBe("checked-in-fallback");
});

test("runtime reads env only as configuration, supports reset generation, and never exposes raw errors", async () => {
  const original = process.env["NAUTILO_APPLICATION_CATALOGUE_POINTER_URL"];
  const fixture = signedFixture();
  try {
    delete process.env["NAUTILO_APPLICATION_CATALOGUE_POINTER_URL"];
    let disabledCalls = 0;
    configureRuntimeApplicationCatalogue({
      fetchImpl: (async () => { disabledCalls += 1; throw new Error("must not fetch"); }) as unknown as typeof fetch,
    });
    kickRuntimeApplicationCatalogueRefresh(1);
    await Promise.resolve();
    expect(disabledCalls).toBe(0);

    process.env["NAUTILO_APPLICATION_CATALOGUE_POINTER_URL"] = "https://example.test/latest.json";
    configureRuntimeApplicationCatalogue({
      trustedKeys: { test: fixture.key },
      fetchImpl: releaseFetch(fixture.pointer, fixture.snapshot),
    });
    expect((await refreshRuntimeApplicationCatalogue()).source).toBe("remote-fresh");
    expect(getActiveApplicationCatalogueResultSync().source).toBe("remote-fresh");

    configureRuntimeApplicationCatalogue({
      pointerUrl: null,
      fetchImpl: (async () => { throw new Error("token=secret-value"); }) as unknown as typeof fetch,
    });
    kickRuntimeApplicationCatalogueRefresh(100_000);
    await Promise.resolve();
    expect(getActiveApplicationCatalogueResultSync().source).toBe("checked-in-fallback");
  } finally {
    if (original === undefined) delete process.env["NAUTILO_APPLICATION_CATALOGUE_POINTER_URL"];
    else process.env["NAUTILO_APPLICATION_CATALOGUE_POINTER_URL"] = original;
    resetRuntimeApplicationCatalogue();
  }
});

test("an old runtime generation cannot publish into or clear a replacement generation", async () => {
  const fixture = signedFixture();
  let resolvePointer: ((response: Response) => void) | undefined;
  let request = 0;
  const delayedFetch = (async () => {
    request += 1;
    if (request === 1) return new Promise<Response>((resolve) => { resolvePointer = resolve; });
    return json(fixture.snapshot);
  }) as unknown as typeof fetch;
  configureRuntimeApplicationCatalogue({
    pointerUrl: "https://example.test/latest.json",
    trustedKeys: { test: fixture.key },
    fetchImpl: delayedFetch,
  });
  const oldRefresh = refreshRuntimeApplicationCatalogue();
  configureRuntimeApplicationCatalogue({ pointerUrl: null });
  resolvePointer?.(json(fixture.pointer));
  await oldRefresh;
  expect(getActiveApplicationCatalogueResultSync().source).toBe("checked-in-fallback");
  resetRuntimeApplicationCatalogue();
});

test("remote failures never echo an untrusted URL or raw error", async () => {
  const result = await createRemoteApplicationCatalogueLoader({
    pointerUrl: "https://example.test/latest.json",
    fetchImpl: (async () => { throw new Error("token=secret-value"); }) as unknown as typeof fetch,
  }).refresh();
  expect(result.reason).toBe("application catalogue refresh failed");
  expect(result.reason).not.toContain("secret");
});
