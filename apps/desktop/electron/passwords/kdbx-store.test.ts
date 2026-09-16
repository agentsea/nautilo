/**
 * D403 (ISSUE-D403) Phase 2 — KdbxStore unit tests (bun:test).
 *
 * Electron-free: exercises the store against a real temp `.kdbx` with an
 * injected fixed 32-byte key. Covers persistence/reload, exact-origin match,
 * getFillValue hit/miss, the on-disk KDBX round-trip (re-opens with the same
 * key), and the R6 invariant that the plaintext password is not on disk.
 *
 * TYPES NOTE: the desktop tsconfig narrows `types` to `["node"]` and typechecks
 * `electron/**` (where this file lives, unlike the repo's other tests under the
 * eslint/tsconfig-excluded `tests/`). So `bun:test` isn't declared for `tsc`
 * here. Rather than importing `bun:test` (unresolvable without pulling the full
 * `bun-types` package, whose global lib augmentations — e.g.
 * `ReadableStreamDefaultReader.readMany` — would leak in and break unrelated
 * `electron/main.ts` types), we type Bun's injected test globals locally via
 * `declare global`. Bun exposes `test`/`expect`/… as globals at runtime, so no
 * import is needed. A triple-slash reference is disallowed by the eslint config.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as kdbxweb from "kdbxweb";

import {
  setKdbxRuntimeImpls,
  setMissingKdbxDomGlobals,
} from "./runtime-impl";
import { KdbxStore } from "./kdbx-store";

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeDefined(): void;
  toHaveLength(length: number): void;
  toBeGreaterThan(n: number): void;
  toBeInstanceOf(expected: unknown): void;
}

// Module-scoped (NOT `declare global`) so the bun-test globals here don't
// augment the program-wide scope and collide with the sibling password test
// files (each declares its own local `expect`/`Matchers`).
declare const describe: (label: string, fn: () => void) => void;
declare const test: (label: string, fn: () => void | Promise<void>) => void;
declare const beforeAll: (fn: () => void | Promise<void>) => void;
declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => Matchers;

// DOM and Argon2 implementations must be installed before any KDBX load/save.
beforeAll(() => {
  setKdbxRuntimeImpls();
});

// Fixed, deterministic 32-byte master key.
const KEY = new Uint8Array(32);
for (let i = 0; i < KEY.length; i++) KEY[i] = (i * 7 + 3) & 0xff;

const tmpFiles: string[] = [];

function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `d403-kdbx-${randomUUID()}.kdbx`);
  tmpFiles.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(
    tmpFiles.splice(0).map((p) => fs.rm(p, { force: true })),
  );
});

async function openWithKey(dbPath: string): Promise<kdbxweb.Kdbx> {
  const data = await fs.readFile(dbPath);
  const ab = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  );
  const keyCopy = Uint8Array.from(KEY);
  const creds = new kdbxweb.Credentials(
    kdbxweb.ProtectedValue.fromBinary(keyCopy.buffer),
  );
  await creds.ready;
  return kdbxweb.Kdbx.load(ab, creds);
}

describe("KdbxStore", () => {
  test("DOM compatibility fills missing globals without replacing host implementations", () => {
    const HostDOMParser = class HostDOMParser {};
    const runtimeGlobals: { DOMParser?: unknown; XMLSerializer?: unknown } = {
      DOMParser: HostDOMParser,
    };

    setMissingKdbxDomGlobals(runtimeGlobals);

    expect(runtimeGlobals.DOMParser).toBe(HostDOMParser);
    expect(typeof runtimeGlobals.XMLSerializer).toBe("function");

    const missingGlobals: { DOMParser?: unknown } = {};
    setMissingKdbxDomGlobals(missingGlobals);
    const Parser = missingGlobals.DOMParser as new () => {
      parseFromString(xml: string, mimeType: string): unknown;
    };
    let rejectedMalformedXml = false;
    try {
      new Parser().parseFromString("<Root><", "application/xml");
    } catch {
      rejectedMalformedXml = true;
    }
    expect(rejectedMalformedXml).toBe(true);
  });

  test("save → reload from disk → lookup returns the entry", async () => {
    const dbPath = tmpDbPath();
    await new KdbxStore(KEY, dbPath).save({
      origin: "https://example.com",
      username: "alice",
      password: "s3cret-pw",
    });

    // Fresh instance forces a real load from disk (no in-memory carryover).
    const reopened = new KdbxStore(KEY, dbPath);
    const matches = await reopened.lookupByOrigin("https://example.com");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.username).toBe("alice");
    expect(typeof matches[0]?.id).toBe("string");
    expect(matches[0]?.id.length).toBeGreaterThan(0);
  });

  test("exact-origin match only: save A → lookup A hit, lookup B empty", async () => {
    const store = new KdbxStore(KEY, tmpDbPath());
    await store.save({
      origin: "https://a.example.com",
      username: "user-a",
      password: "pw-a",
    });

    expect(await store.lookupByOrigin("https://a.example.com")).toHaveLength(1);
    // Different origin — never a cross-origin match.
    expect(await store.lookupByOrigin("https://b.example.com")).toHaveLength(0);
    // Not a prefix/substring match either.
    expect(await store.lookupByOrigin("https://a.example.com/")).toHaveLength(
      0,
    );
    expect(await store.lookupByOrigin("http://a.example.com")).toHaveLength(0);
  });

  test("getFillValue returns the password for a valid id and null for an unknown id", async () => {
    const store = new KdbxStore(KEY, tmpDbPath());
    await store.save({
      origin: "https://fill.example.com",
      username: "bob",
      password: "hunter2",
    });

    const [match] = await store.lookupByOrigin("https://fill.example.com");
    expect(match).toBeDefined();
    const fill = await store.getFillValue(match!.id);
    expect(fill).toEqual({ username: "bob", password: "hunter2" });

    expect(await store.getFillValue("does-not-exist")).toBeNull();
  });

  test("upsert: saving the same origin twice updates in place (no duplicate)", async () => {
    const store = new KdbxStore(KEY, tmpDbPath());
    await store.save({
      origin: "https://up.example.com",
      username: "carol",
      password: "old-pw",
    });
    await store.save({
      origin: "https://up.example.com",
      username: "carol",
      password: "new-pw",
    });

    const matches = await store.lookupByOrigin("https://up.example.com");
    expect(matches).toHaveLength(1);
    const fill = await store.getFillValue(matches[0]!.id);
    expect(fill?.password).toBe("new-pw");
  });

  test("on-disk bytes are a valid KDBX that re-opens with the same key", async () => {
    const dbPath = tmpDbPath();
    const password = "round-trip-plaintext";
    await new KdbxStore(KEY, dbPath).save({
      origin: "https://roundtrip.example.com",
      username: "dave",
      password,
    });

    const bytes = await fs.readFile(dbPath);
    // KDBX file magic (little-endian 0x9AA2D903): first bytes 03 D9 A2 9A.
    expect(bytes[0]).toBe(0x03);
    expect(bytes[1]).toBe(0xd9);
    expect(bytes[2]).toBe(0xa2);
    expect(bytes[3]).toBe(0x9a);
    expect(bytes.length).toBeGreaterThan(64);

    // R6 invariant: the plaintext password must not appear on disk.
    expect(bytes.includes(Buffer.from(password, "utf-8"))).toBe(false);

    // Re-open the raw file with the same key via kdbxweb directly.
    const db = await openWithKey(dbPath);
    const entries = [...db.getDefaultGroup().allEntries()];
    const entry = entries.find(
      (e) => e.fields.get("URL") === "https://roundtrip.example.com",
    );
    expect(entry).toBeDefined();
    const pw = entry!.fields.get("Password");
    expect(pw).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect((pw as kdbxweb.ProtectedValue).getText()).toBe(password);
  });

  test("re-opening with a wrong key fails", async () => {
    const dbPath = tmpDbPath();
    await new KdbxStore(KEY, dbPath).save({
      origin: "https://wrongkey.example.com",
      username: "erin",
      password: "pw",
    });

    const wrongKey = new Uint8Array(32).fill(0xab);
    const wrongStore = new KdbxStore(wrongKey, dbPath);
    let threw = false;
    try {
      await wrongStore.lookupByOrigin("https://wrongkey.example.com");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("matchCredential classifies absent / identical / password-differs", async () => {
    const store = new KdbxStore(KEY, tmpDbPath());
    const origin = "https://match.example.com";
    await store.save({ origin, username: "sam", password: "pw1" });

    expect(await store.matchCredential(origin, "sam", "pw1")).toBe("identical");
    expect(await store.matchCredential(origin, "sam", "pw2")).toBe(
      "password-differs",
    );
    // Same origin, different username → no entry for that user.
    expect(await store.matchCredential(origin, "other", "pw1")).toBe("absent");
    // Different origin → absent.
    expect(
      await store.matchCredential("https://nope.example.com", "sam", "pw1"),
    ).toBe("absent");
  });
});
