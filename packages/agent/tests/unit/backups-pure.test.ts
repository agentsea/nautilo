/**
 * D087 Phase 2A §12.4 — pure unit tests for the backup subsystem.
 *
 * Scope: only the stateless, side-effect-free pieces of the module
 * are tested here. No DB, no storage provider, no file system.
 * Covers:
 *
 *   - `looksLikeBinary` heuristic (null-byte scan window).
 *   - `isSha256Hex` / `isHex2` validators.
 *   - `blobRelPathFor` canonical-path derivation (happy + reject).
 *   - `buildReverseDiff` round-trip via `diff.applyPatch` — the
 *     correctness invariant the hot lane depends on.
 *
 * Integration / DB-backed behaviour (routing, insert, dedup, GC) is
 * in `tests/integration/backups-e2e.test.ts`.
 */

import { describe, test, expect } from "bun:test";
import { applyPatch } from "diff";
import { looksLikeBinary } from "../../src/tools/file/commands/_shared";
import { buildReverseDiff } from "../../src/tools/file/backups/hot-lane";
import {
  blobRelPathFor,
  isHex2,
  isSha256Hex,
} from "../../src/tools/file/backups/storage-registry";

// ---------------------------------------------------------------------
// looksLikeBinary
// ---------------------------------------------------------------------

describe("looksLikeBinary — null-byte heuristic", () => {
  test("plain UTF-8 text returns false", () => {
    expect(looksLikeBinary(Buffer.from("hello world"))).toBe(false);
  });

  test("empty buffer returns false (nothing to sniff)", () => {
    expect(looksLikeBinary(Buffer.alloc(0))).toBe(false);
  });

  test("markdown with code fences returns false", () => {
    const md = "# Title\n\n```ts\nconst x = 1;\n```\n";
    expect(looksLikeBinary(Buffer.from(md))).toBe(false);
  });

  test("unicode (emoji, CJK) returns false", () => {
    expect(
      looksLikeBinary(Buffer.from("ok 日本語 🚀 emoji test")),
    ).toBe(false);
  });

  test("buffer with a null byte in the first 8 KB returns true", () => {
    const buf = Buffer.concat([
      Buffer.from("prefix"),
      Buffer.from([0x00]),
      Buffer.from("suffix"),
    ]);
    expect(looksLikeBinary(buf)).toBe(true);
  });

  test("null byte OUTSIDE the default 8 KB window returns false", () => {
    // 10_000 ASCII chars, then a null byte — default window is 8192 so
    // the null byte is never reached.
    const pre = "a".repeat(10_000);
    const buf = Buffer.concat([Buffer.from(pre), Buffer.from([0x00])]);
    expect(looksLikeBinary(buf)).toBe(false);
  });

  test("custom smaller window misses a later null byte", () => {
    const buf = Buffer.concat([
      Buffer.from("aaaa"),
      Buffer.from([0x00]),
    ]);
    // First 2 bytes = "aa" — no null.
    expect(looksLikeBinary(buf, 2)).toBe(false);
    // Full length — finds the null.
    expect(looksLikeBinary(buf, 10)).toBe(true);
  });

  test("real-world PNG magic bytes return true (leading NUL pattern)", () => {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A — no null in the first 8
    // bytes, but real PNGs hit null bytes very quickly in the IHDR
    // chunk header. Simulate that realistically.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]), // chunk length
      Buffer.from("IHDR"),
    ]);
    expect(looksLikeBinary(png)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// isSha256Hex / isHex2
// ---------------------------------------------------------------------

describe("sha256 / hex validators", () => {
  const VALID_SHA =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("isSha256Hex accepts exactly 64 lowercase hex chars", () => {
    expect(isSha256Hex(VALID_SHA)).toBe(true);
  });

  test("isSha256Hex rejects uppercase hex (our canonical is lowercase)", () => {
    expect(isSha256Hex(VALID_SHA.toUpperCase())).toBe(false);
  });

  test("isSha256Hex rejects wrong-length strings", () => {
    expect(isSha256Hex("")).toBe(false);
    expect(isSha256Hex("abc")).toBe(false);
    expect(isSha256Hex(`${VALID_SHA}0`)).toBe(false);
    expect(isSha256Hex(VALID_SHA.slice(0, 63))).toBe(false);
  });

  test("isSha256Hex rejects non-hex characters", () => {
    const withG = `g${VALID_SHA.slice(1)}`;
    expect(isSha256Hex(withG)).toBe(false);
    // Traversal attempt disguised as a sha prefix.
    const evil = "../../../etc/passwd".padEnd(64, "0");
    expect(isSha256Hex(evil)).toBe(false);
  });

  test("isHex2 accepts exactly two lowercase hex chars", () => {
    expect(isHex2("0a")).toBe(true);
    expect(isHex2("ff")).toBe(true);
    expect(isHex2("12")).toBe(true);
  });

  test("isHex2 rejects anything else", () => {
    expect(isHex2("")).toBe(false);
    expect(isHex2("a")).toBe(false);
    expect(isHex2("abc")).toBe(false);
    expect(isHex2("0A")).toBe(false); // uppercase
    expect(isHex2(".ds")).toBe(false);
    expect(isHex2(".DS_Store")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// blobRelPathFor
// ---------------------------------------------------------------------

describe("blobRelPathFor canonical path", () => {
  const VALID_SHA =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

  test("returns 256-way fan-out path for a valid sha256", () => {
    expect(blobRelPathFor(VALID_SHA)).toBe(
      `backups/blobs/sha256/ab/${VALID_SHA}`,
    );
  });

  test("throws on a malformed sha256 (prevents a downstream traversal)", () => {
    expect(() => blobRelPathFor("not-a-sha")).toThrow(/blob sha256/);
    // Exact-64 length but with a slash: must also be rejected.
    const slashed = "../etc/passwd".padEnd(64, "a");
    expect(() => blobRelPathFor(slashed)).toThrow(/blob sha256/);
  });

  test("throws on empty string", () => {
    expect(() => blobRelPathFor("")).toThrow(/blob sha256/);
  });

  test("first two chars of sha determine the fan-bucket", () => {
    const sha = "00" + "a".repeat(62);
    expect(blobRelPathFor(sha)).toBe(`backups/blobs/sha256/00/${sha}`);
  });
});

// ---------------------------------------------------------------------
// buildReverseDiff + applyPatch round-trip
// ---------------------------------------------------------------------

describe("buildReverseDiff round-trip (hot-lane correctness invariant)", () => {
  /** Helper: assert that applying the reverse-diff to `post` reproduces
   *  `pre` byte-for-byte. This is the invariant Phase 3's `/undo`
   *  depends on. */
  function expectRoundTrip(pre: string, post: string) {
    const diff = buildReverseDiff("/tmp/test.md", Buffer.from(pre), Buffer.from(post));
    const reconstructed = applyPatch(post, diff);
    expect(reconstructed).toBe(pre);
  }

  test("identical pre/post round-trips (even if diff is empty)", () => {
    expectRoundTrip("hello\n", "hello\n");
  });

  test("single-line change round-trips", () => {
    expectRoundTrip("foo\n", "bar\n");
  });

  test("multi-line change round-trips", () => {
    const pre = "line 1\nline 2\nline 3\n";
    const post = "line 1\nLINE TWO (changed)\nline 3\n";
    expectRoundTrip(pre, post);
  });

  test("new-line appended at end round-trips", () => {
    expectRoundTrip("hello", "hello\nworld");
  });

  test("complete rewrite round-trips", () => {
    const pre = "original content here\n";
    const post = "totally different stuff\nthat replaces everything\n";
    expectRoundTrip(pre, post);
  });

  test("empty pre (new-file write) round-trips", () => {
    expectRoundTrip("", "newly created\ncontent\n");
  });

  test("empty post round-trips (pre ← empty)", () => {
    // Note: the restore use case for this is not typical (Phase 2A's
    // cold-lane handles the "pre had content, post is empty" case as
    // a delete tombstone, not a hot-lane diff). But Myers should
    // still handle the symmetry correctly.
    expectRoundTrip("had content\n", "");
  });

  test("unicode / emoji content round-trips", () => {
    expectRoundTrip("日本語 🚀 line\n", "日本語 🚀 line changed ✨\n");
  });

  test("markdown code fences round-trip without the fence grammar breaking", () => {
    const pre = "# Title\n\n```ts\nconst x = 1;\n```\n";
    const post = "# Title\n\n```ts\nconst x = 2;\n```\n";
    expectRoundTrip(pre, post);
  });

  test("large text block with small edit round-trips", () => {
    const base = "lorem ipsum ".repeat(200) + "\n";
    expectRoundTrip(base, base + "extra line\n");
  });
});
