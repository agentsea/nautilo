import { describe, expect, test } from "bun:test";
import {
  BROWSER_PAGE_READ_DEFAULT_MAX_CHARS,
  BROWSER_PAGE_READ_MAX_CHARS,
  BROWSER_PAGE_SNAPSHOT_FIND_MAX_RESPONSE_CHARACTERS,
  chunkBrowserPageReadResult,
  type BrowserPageSnapshotFindResult,
  type BrowserPageSnapshotRangeResult,
  type BrowserPageReadResult,
} from "@nautilo/relay";
import {
  dispatchBrowserPageContinuation,
  dispatchBrowserPageSnapshotInspection,
} from "../../electron/browser-page-read-dispatch";
import {
  BROWSER_PAGE_SNAPSHOT_MAX_BYTES,
  BrowserPageSnapshotStore,
  type BrowserPageSnapshotOwnerBinding,
} from "../../electron/browser-page-snapshot-store";

const OWNER: BrowserPageSnapshotOwnerBinding = {
  instanceId: "instance-1",
  userId: "user-1",
  relayId: "relay-1",
  desktopSessionId: "desktop-1",
};

function page(content: string): BrowserPageReadResult {
  return {
    targetRole: "interactive",
    finalUrl: "https://example.test/article",
    title: "Example article",
    content,
    blocks: [],
    totalCharacters: content.length,
    totalCharactersCapped: false,
    totalBytes: Buffer.byteLength(content, "utf8"),
    estimatedTokens: Math.ceil(content.length / 4),
    offsetCharacters: 0,
    nextOffsetCharacters: content.length,
    returnedCharacters: content.length,
    remainingCharacters: 0,
    eof: true,
    truncated: false,
    contextClamped: false,
    extraction: { method: "mozilla-readability-turndown-v1", root: "article", iframeCount: 0 },
    timing: { readiness: "complete" },
    quality: "complete",
    challenge: { detected: false, confidence: "none", signals: [] },
    failure: "none",
    diagnostics: [],
  };
}

describe("BrowserPageSnapshotStore", () => {
  test("retains a ~159K semantic page once and pages every character to EOF without a live target", () => {
    const content = Array.from({ length: 1_600 }, (_, index) =>
      `## Section ${index}\n\n${"semantic Markdown evidence ".repeat(3)}${index}\n`,
    ).join("\n");
    expect(content.length).toBeGreaterThan(159_000);
    const store = new BrowserPageSnapshotStore();
    const created = store.create(OWNER, page(content));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected page snapshot");

    const chunks: string[] = [];
    let offset = 0;
    do {
      const result = dispatchBrowserPageContinuation({
        continuation: {
          version: 1,
          reference: created.snapshot.reference,
          offsetCharacters: offset,
          mode: "page",
        },
      }, { snapshotStore: store, snapshotOwner: OWNER });
      expect(result.status).toBe("ok");
      const chunk = result.result as BrowserPageReadResult;
      expect(chunk.offsetCharacters).toBe(offset);
      expect(chunk.returnedCharacters).toBe(chunk.content.length);
      expect(chunk.nextOffsetCharacters - chunk.offsetCharacters).toBe(chunk.content.length);
      // v12 continuation remains usable, but must never receive v13-only
      // snapshot-inspection publication fields.
      expect(chunk.pageReference).toBeUndefined();
      chunks.push(chunk.content);
      offset = chunk.nextOffsetCharacters;
      if (chunk.eof) break;
      expect(chunk.continuation?.reference).toBe(created.snapshot.reference);
    } while (true);
    expect(chunks.join("")).toBe(content);
    expect(offset).toBe(content.length);

    const whole = dispatchBrowserPageContinuation({
      continuation: {
        version: 1,
        reference: created.snapshot.reference,
        offsetCharacters: 0,
        mode: "remainder",
      },
    }, { snapshotStore: store, snapshotOwner: OWNER });
    expect(whole.status).toBe("ok");
    expect((whole.result as BrowserPageReadResult).content).toBe(content);
    expect((whole.result as BrowserPageReadResult)).toMatchObject({ eof: true, contextClamped: false });

    const inspectable = dispatchBrowserPageContinuation({
      continuation: {
        version: 1,
        reference: created.snapshot.reference,
        offsetCharacters: 0,
        mode: "page",
      },
    }, {
      snapshotStore: store,
      snapshotOwner: OWNER,
      publishSnapshotReference: true,
    });
    expect(inspectable.status).toBe("ok");
    const inspectablePage = inspectable.result as BrowserPageReadResult;
    expect(inspectablePage.continuation?.reference).toBe(created.snapshot.reference);
    expect(inspectablePage.pageReference).toEqual({
      version: 1,
      reference: created.snapshot.reference,
      expiresAt: inspectablePage.continuation?.expiresAt,
    });
  });

  test("prefers Markdown block boundaries and truthfully splits one oversized block", () => {
    const structural = page("# Heading\n\nFirst paragraph.\n\nSecond paragraph.");
    const structuralChunk = chunkBrowserPageReadResult(structural, { offsetCharacters: 0, maxChars: 30, mode: "page" });
    expect(structuralChunk.content).toBe("# Heading\n\nFirst paragraph.\n\n");

    const oversized = page("x".repeat(71));
    const pieces: string[] = [];
    let offset = 0;
    while (offset < oversized.content.length) {
      const chunk = chunkBrowserPageReadResult(oversized, { offsetCharacters: offset, maxChars: 10, mode: "page" });
      expect(chunk.nextOffsetCharacters).toBeGreaterThan(offset);
      pieces.push(chunk.content);
      offset = chunk.nextOffsetCharacters;
    }
    expect(pieces.join("")).toBe(oversized.content);
  });

  test("marks a whole remainder truthfully when the fixed response ceiling clamps it", () => {
    const content = "x".repeat(BROWSER_PAGE_READ_MAX_CHARS + 11);
    const chunk = chunkBrowserPageReadResult(page(content), { offsetCharacters: 0, mode: "remainder" });
    expect(chunk.returnedCharacters).toBe(BROWSER_PAGE_READ_MAX_CHARS);
    expect(chunk.remainingCharacters).toBe(11);
    expect(chunk).toMatchObject({ eof: false, truncated: true, contextClamped: true });
  });

  test("enforces owner, TTL, deterministic eviction, item and aggregate bounds, and close", () => {
    let now = 1_000;
    const store = new BrowserPageSnapshotStore({ ttlMs: 5, now: () => now });
    const first = store.create(OWNER, page("one"));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first snapshot");
    expect(store.access(first.snapshot.reference, { ...OWNER, desktopSessionId: "other" })).toEqual({ ok: false, reason: "snapshot_unavailable" });
    now += 5;
    expect(store.access(first.snapshot.reference, OWNER)).toEqual({ ok: false, reason: "snapshot_expired" });

    now = 10;
    const entries = Array.from({ length: 17 }, (_, index) => store.create(OWNER, page(`page-${index}`)));
    expect(entries.every((entry) => entry.ok)).toBe(true);
    expect(store.debugState().entries).toBe(16);
    const oldest = entries[0];
    if (!oldest.ok) throw new Error("expected snapshot");
    expect(store.access(oldest.snapshot.reference, OWNER)).toEqual({ ok: false, reason: "snapshot_evicted" });

    expect(store.create(OWNER, page("x".repeat(BROWSER_PAGE_SNAPSHOT_MAX_BYTES + 1)))).toEqual({ ok: false, reason: "item-too-large" });
    store.close();
    expect(store.debugState()).toEqual({ entries: 0, retainedBytes: 0 });

    const aggregate = new BrowserPageSnapshotStore();
    const fullItem = page("x".repeat(BROWSER_PAGE_SNAPSHOT_MAX_BYTES));
    const aggregateEntries = Array.from({ length: 9 }, () => aggregate.create(OWNER, fullItem));
    expect(aggregate.debugState().entries).toBe(8);
    const aggregateOldest = aggregateEntries[0];
    if (!aggregateOldest.ok) throw new Error("expected aggregate snapshot");
    expect(aggregate.access(aggregateOldest.snapshot.reference, OWNER)).toEqual({ ok: false, reason: "snapshot_evicted" });
  });

  test("uses a sliding TTL and prevents an old expiry timer from deleting a touched snapshot", () => {
    let now = 0;
    const callbacks: Array<() => void> = [];
    const store = new BrowserPageSnapshotStore({
      ttlMs: 5,
      now: () => now,
      setTimeout: (callback) => {
        callbacks.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    });
    const created = store.create(OWNER, page("touched"));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");

    now = 3;
    expect(store.access(created.snapshot.reference, OWNER)).toMatchObject({ ok: true, expiresAt: new Date(8).toISOString() });
    expect(callbacks).toHaveLength(2);

    now = 5;
    callbacks[0]!();
    expect(store.access(created.snapshot.reference, OWNER)).toMatchObject({ ok: true });

    now = 10;
    callbacks[1]!();
    expect(store.access(created.snapshot.reference, OWNER)).toEqual({ ok: false, reason: "snapshot_expired" });
  });

  test("does not touch a snapshot before rejecting a wrong target role", () => {
    let now = 0;
    const store = new BrowserPageSnapshotStore({ ttlMs: 5, now: () => now });
    const created = store.create(OWNER, page("role-bound"));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    now = 4;
    expect(store.access(created.snapshot.reference, OWNER, "research")).toEqual({ ok: false, reason: "snapshot_unavailable" });
    now = 5;
    expect(store.access(created.snapshot.reference, OWNER)).toEqual({ ok: false, reason: "snapshot_expired" });
  });

  test("finds normalized Markdown text across wrapped whitespace, escaped punctuation, link labels, and Unicode with original offsets", () => {
    const content = "# Heading\n\nCyclic\nimports: [Café \"guide\"](https://example.test/cafe) says \\*important\\*.\n\nTail";
    const store = new BrowserPageSnapshotStore();
    const created = store.create(OWNER, page(content));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    const result = dispatchBrowserPageSnapshotInspection({
      snapshot: {
        version: 1,
        operation: "find",
        reference: created.snapshot.reference,
        query: "cyclic imports: Café \"guide\" says *important*",
      },
    }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true });
    expect(result.status).toBe("ok");
    const found = result.result as BrowserPageSnapshotFindResult;
    expect(found).toMatchObject({ totalMatches: 1, returnedMatches: 1, matchesOmitted: 0, caseSensitive: false });
    const match = found.matches[0]!;
    expect(match.offsetCharacters).toBe(content.indexOf("Cyclic"));
    expect(content.slice(match.offsetCharacters, match.offsetCharacters + match.matchCharacters)).toBe(
      "Cyclic\nimports: [Café \"guide\"](https://example.test/cafe) says \\*important\\*",
    );
  });

  test("scans densely to exact completion while bounding serialized UTF-8 find output", () => {
    const content = Array.from({ length: 100 }, () => "needle 😀 evidence").join("\n\n");
    const store = new BrowserPageSnapshotStore();
    const created = store.create(OWNER, page(content));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    const result = dispatchBrowserPageSnapshotInspection({
      snapshot: {
        version: 1,
        operation: "find",
        reference: created.snapshot.reference,
        query: "needle",
        maxMatches: 16,
        previewCharacters: 1_024,
      },
    }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true });
    expect(result.status).toBe("ok");
    const found = result.result as BrowserPageSnapshotFindResult;
    expect(found.totalMatches).toBe(100);
    expect(found.returnedMatches).toBe(found.matches.length);
    expect(found.matchesOmitted).toBe(100 - found.matches.length);
    expect(found.matchesOmitted).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(found), "utf8")).toBeLessThanOrEqual(BROWSER_PAGE_SNAPSHOT_FIND_MAX_RESPONSE_CHARACTERS);
  });

  test("expands an exact snapshot offset asymmetrically and reports raw Markdown block cuts", () => {
    const content = "# Heading\n\nFirst paragraph has target and more text.\n\nSecond paragraph.";
    const store = new BrowserPageSnapshotStore();
    const created = store.create(OWNER, page(content));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    const offset = content.indexOf("target");
    const result = dispatchBrowserPageSnapshotInspection({
      snapshot: {
        version: 1,
        operation: "range",
        reference: created.snapshot.reference,
        offsetCharacters: offset,
        beforeCharacters: 3,
        afterCharacters: 9,
      },
    }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true });
    expect(result.status).toBe("ok");
    const range = result.result as BrowserPageSnapshotRangeResult;
    expect(range).toMatchObject({
      startOffsetCharacters: offset - 3,
      endOffsetCharacters: offset + 9,
      content: content.slice(offset - 3, offset + 9),
      startsMidBlock: true,
      endsMidBlock: true,
      truncatedBlock: true,
    });
  });

  test("keeps range edges on complete UTF-16 code points and preserves exact range relations", () => {
    const content = "Before 😀 after";
    const store = new BrowserPageSnapshotStore();
    const created = store.create(OWNER, page(content));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    const offset = content.indexOf("😀");
    const result = dispatchBrowserPageSnapshotInspection({ snapshot: {
      version: 1,
      operation: "range",
      reference: created.snapshot.reference,
      offsetCharacters: offset,
      beforeCharacters: 0,
      afterCharacters: 1,
    } }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true });
    expect(result.status).toBe("ok");
    const range = result.result as BrowserPageSnapshotRangeResult;
    expect(range).toMatchObject({
      startOffsetCharacters: offset,
      endOffsetCharacters: offset + "😀".length,
      content: "😀",
    });
    expect(range.content.length).toBe(range.endOffsetCharacters - range.startOffsetCharacters);
  });

  test("does not treat blank lines inside a fenced block as structural boundaries", () => {
    const content = "```ts\nconst first = 1;\n\nconst second = 2;\n```\n\nAfter.";
    const store = new BrowserPageSnapshotStore();
    const created = store.create(OWNER, page(content));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    const first = content.indexOf("const first");
    const result = dispatchBrowserPageSnapshotInspection({ snapshot: {
      version: 1,
      operation: "range",
      reference: created.snapshot.reference,
      offsetCharacters: first,
      beforeCharacters: 0,
      afterCharacters: "const first = 1;".length,
    } }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true });
    expect(result.status).toBe("ok");
    expect(result.result).toMatchObject({
      content: "const first = 1;",
      startsMidBlock: true,
      endsMidBlock: true,
      truncatedBlock: true,
    });
  });

  test("rejects invalid, foreign, and wrong-role snapshot inspection without refreshing TTL", () => {
    let now = 0;
    const store = new BrowserPageSnapshotStore({ ttlMs: 5, now: () => now });
    const created = store.create(OWNER, page("needle"));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    now = 4;
    expect(dispatchBrowserPageSnapshotInspection({ snapshot: {
      version: 1, operation: "find", reference: created.snapshot.reference, query: "   ",
    } }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true })).toMatchObject({
      status: "error", errorCode: "BROWSER_PAGE_SNAPSHOT_REQUEST_INVALID",
    });
    expect(dispatchBrowserPageSnapshotInspection({ snapshot: {
      version: 1, operation: "find", reference: created.snapshot.reference, query: "needle",
    } }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true, expectedTargetRole: "research" })).toMatchObject({
      status: "error", errorCode: "BROWSER_PAGE_SNAPSHOT_UNAVAILABLE",
    });
    expect(dispatchBrowserPageSnapshotInspection({ snapshot: {
      version: 1, operation: "range", reference: created.snapshot.reference, offsetCharacters: 99,
    } }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true })).toMatchObject({
      status: "error", errorCode: "BROWSER_PAGE_SNAPSHOT_OFFSET_INVALID",
    });
    now = 5;
    expect(store.access(created.snapshot.reference, OWNER)).toEqual({ ok: false, reason: "snapshot_expired" });
  });

  test("refreshes the sliding TTL only after successful immutable find and range", () => {
    let now = 0;
    const store = new BrowserPageSnapshotStore({ ttlMs: 5, now: () => now });
    const created = store.create(OWNER, page("target evidence"));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    now = 3;
    expect(dispatchBrowserPageSnapshotInspection({ snapshot: {
      version: 1, operation: "find", reference: created.snapshot.reference, query: "target",
    } }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true })).toMatchObject({
      status: "ok", result: { expiresAt: new Date(8).toISOString() },
    });
    now = 7;
    expect(dispatchBrowserPageSnapshotInspection({ snapshot: {
      version: 1, operation: "range", reference: created.snapshot.reference, offsetCharacters: 0,
    } }, { snapshotStore: store, snapshotOwner: OWNER, publishSnapshotReference: true })).toMatchObject({
      status: "ok", result: { expiresAt: new Date(12).toISOString() },
    });
    now = 11;
    expect(store.access(created.snapshot.reference, OWNER)).toMatchObject({ ok: true });
  });

  test("bounds content-free tombstones and discloses only same-owner eviction metadata", () => {
    const store = new BrowserPageSnapshotStore();
    const otherOwner = { ...OWNER, userId: "other-user" };
    const otherEntries = Array.from({ length: 16 }, (_, index) => store.create(otherOwner, page(`other-${index}`)));
    expect(otherEntries.every((entry) => entry.ok)).toBe(true);

    const crossOwner = store.create(OWNER, page("mine"));
    expect(crossOwner).toMatchObject({ ok: true, evicted: [] });

    const ownStore = new BrowserPageSnapshotStore();
    const ownEntries = Array.from({ length: 16 }, (_, index) => ownStore.create(OWNER, page(`mine-${index}`)));
    const displaced = ownEntries[0];
    if (!displaced?.ok) throw new Error("expected snapshot");
    const sameOwner = ownStore.create(OWNER, page("new-mine"));
    expect(sameOwner).toEqual({
      ok: true,
      snapshot: expect.objectContaining({ version: 1 }),
      evicted: [{
        version: 1,
        reference: displaced.snapshot.reference,
        title: "Example article",
        finalUrl: "https://example.test/article",
      }],
    });

    const tombstones = new BrowserPageSnapshotStore();
    Array.from({ length: 49 }, (_, index) => tombstones.create(OWNER, page(`page-${index}`)));
    expect(tombstones.debugTombstones().entries).toBe(32);
    expect(tombstones.debugTombstones().reasons.every((reason) => reason === "snapshot_evicted")).toBe(true);
  });

  test("rejects bad, unavailable, and restarted continuation references without touching a current page", () => {
    const store = new BrowserPageSnapshotStore();
    const created = store.create(OWNER, page("data"));
    expect(created.ok).toBe(true);
    const unavailable = dispatchBrowserPageContinuation({ continuation: { version: 1, reference: "x".repeat(43), offsetCharacters: 0, mode: "page" } }, {});
    expect(unavailable).toMatchObject({ status: "error", errorCode: "BROWSER_PAGE_CONTINUATION_UNAVAILABLE" });
    const missing = dispatchBrowserPageContinuation({ continuation: { version: 1, reference: "x".repeat(43), offsetCharacters: 0, mode: "page" } }, { snapshotStore: store, snapshotOwner: OWNER });
    expect(missing).toMatchObject({ status: "error", errorCode: "BROWSER_PAGE_SNAPSHOT_UNAVAILABLE" });
    expect(missing.error).toContain("Re-read the original URL to get a fresh reference; content may have changed.");
    const bad = dispatchBrowserPageContinuation({ continuation: { version: 1, reference: "short", offsetCharacters: 0, mode: "page" } }, { snapshotStore: store, snapshotOwner: OWNER });
    expect(bad).toMatchObject({ status: "error", errorCode: "BROWSER_PAGE_CONTINUATION_REQUEST_INVALID" });
    if (!created.ok) throw new Error("expected snapshot");
    const skipped = dispatchBrowserPageContinuation({ continuation: {
      version: 1,
      reference: created.snapshot.reference,
      offsetCharacters: 5,
      mode: "page",
    } }, { snapshotStore: store, snapshotOwner: OWNER });
    expect(skipped).toMatchObject({ status: "error", errorCode: "BROWSER_PAGE_CONTINUATION_OFFSET_INVALID" });
    // A reconnect with the same per-launch session keeps the local owner;
    // a process restart has a fresh in-memory store and cannot revive it.
    expect(store.read(created.snapshot.reference, OWNER)).not.toBeNull();
    expect(new BrowserPageSnapshotStore().read(created.snapshot.reference, OWNER)).toBeNull();
    expect(BROWSER_PAGE_READ_DEFAULT_MAX_CHARS).toBe(24_000);
  });

  test("defensively copies nested snapshot state on create and read", () => {
    const store = new BrowserPageSnapshotStore();
    const original = page("immutable content");
    original.blocks = [{
      kind: "paragraph",
      text: "original block",
      links: [{ text: "original link", href: "https://example.test/original" }],
    }];
    original.challenge.signals.push("captcha");
    const created = store.create(OWNER, original);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");

    original.title = "mutated source";
    original.blocks[0]!.text = "mutated source block";
    original.blocks[0]!.links![0]!.text = "mutated source link";
    original.challenge.signals[0] = "turnstile";

    const first = store.read(created.snapshot.reference, OWNER);
    expect(first).not.toBeNull();
    first!.page.title = "mutated read";
    first!.page.blocks[0]!.text = "mutated read block";
    first!.page.blocks[0]!.links![0]!.text = "mutated read link";
    first!.page.challenge.signals[0] = "hcaptcha";

    expect(store.read(created.snapshot.reference, OWNER)?.page).toMatchObject({
      title: "Example article",
      blocks: [{ text: "original block", links: [{ text: "original link" }] }],
      challenge: { signals: ["captcha"] },
    });
  });
});
