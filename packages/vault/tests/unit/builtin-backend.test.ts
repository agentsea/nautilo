import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveNautiloRuntimePaths, ensureDirectoryTree } from "@nautilo/config";

import type { ConnectionScope } from "@nautilo/types";

import type { BuiltinVaultBackend } from "../../src/builtin-vault-backend.ts";

import {
  BuiltinVaultBackend as Backend,
  MemoryVaultMasterPersistence,
  VaultCryptoError,
  VaultLockedError,
  VaultSchemaError,
  VaultScopeError,
  resolveVaultEncryptedFilePath,
} from "../../src/index.ts";

const installId = "test-install";

let tmpHome: string;
let vaultPath: string;
let persistence: MemoryVaultMasterPersistence;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "nautilo-vault-"));

  delete process.env["NAUTILO_HOME"];
  delete process.env["NAUTILO_INSTANCE_ID"];

  const paths = resolveNautiloRuntimePaths({ userHomeDir: tmpHome });
  await ensureDirectoryTree(paths);

  vaultPath = resolveVaultEncryptedFilePath(paths);

  persistence = new MemoryVaultMasterPersistence();
});

afterEach(async () => {
  delete process.env["NAUTILO_HOME"];
  delete process.env["NAUTILO_INSTANCE_ID"];

  await rm(tmpHome, { force: true, recursive: true });
});

function makeVault(): BuiltinVaultBackend {
  return new Backend({
    installId,
    masterPersistence: persistence,
    vaultPath,
  });
}

function nsScope(namespaceId: string, agentId: string): ConnectionScope {
  return {
    agentId,
    defaultNamespaceId: namespaceId,
    readableNamespaceIds: [namespaceId],
  };
}

describe("@nautilo/vault BuiltinVaultBackend", () => {
  test("plaintext round-trip survives disk reload", async () => {
    let v = makeVault();

    await v.loadFromDisk();

    await v.set(
      { field: "t", service: "s" },
      Buffer.from("plain"),
      nsScope("n1", "a1"),
    );

    v = await reload();

    expect(
      (await v.get({ field: "t", service: "s" }, nsScope("n1", "a1")))?.toString("utf8"),
    ).toBe("plain");
  });

  test("vault envelope writes create owner-only files", async () => {
    const v = makeVault();

    await v.loadFromDisk();
    await v.set(
      { field: "t", service: "s" },
      Buffer.from("plain"),
      nsScope("n1", "a1"),
    );

    const mode = (await stat(vaultPath)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  test("malformed vault file throws schema error", async () => {
    await mkdir(join(tmpHome, "vault"), { recursive: true });

    await writeFile(vaultPath, "{ not-json", { encoding: "utf8" });

    const v = makeVault();

    let caught = false;
    try {
      await v.loadFromDisk();
    } catch (error) {

      caught = true;
      expect(error).toBeInstanceOf(VaultSchemaError);
    }

    expect(caught).toBe(true);
  });

  test("unknown schema_version rejected", async () => {
    await mkdir(join(tmpHome, "vault"), { recursive: true });

    await writeFile(
      vaultPath,
      JSON.stringify({
        config: { encryption_mode: "none" },
        metadata: {},
        schema_version: 99,
        secrets: {},
      }),
      { encoding: "utf8" },
    );

    const v = makeVault();

    let caughtUnknown = false;

    try {

      await v.loadFromDisk();

    } catch (error) {

      caughtUnknown = true;
      expect(error).toBeInstanceOf(VaultSchemaError);
    }

    expect(caughtUnknown).toBe(true);
  });

  test("encrypted store locks until unlock restores reads", async () => {
    let v = makeVault();

    await v.loadFromDisk();

    await v.set(
      { field: "x", service: "y" },
      Buffer.from("v"),
      nsScope("n", "a"),
    );

    await v.enableEncryption({});

    v = await reload();

    expect(v.state).toBe("encrypted_locked");

    let lockedErr: unknown;
    try {

      await v.get({ field: "x", service: "y" }, nsScope("n", "a"));

    } catch (error) {

      lockedErr = error;
    }

    expect(lockedErr).toBeInstanceOf(VaultLockedError);

    await v.unlock({});

    const got = await v.get({ field: "x", service: "y" }, nsScope("n", "a"));

    expect(got?.toString()).toBe("v");
  });

  test("tampered sentinel blob fails unlock", async () => {
    await mkdir(join(tmpHome, "vault"), { recursive: true });

    let v = makeVault();

    await v.loadFromDisk();

    await v.set(
      { field: "x", service: "y" },
      Buffer.from("payload"),
      nsScope("n", "a"),
    );

    await v.enableEncryption({});

    const rawParsed = JSON.parse(await readFile(vaultPath, "utf8")) as {
      encryption?: { sentinel?: { blob: string; n: string } };
    };

    rawParsed.encryption ??= {};
    rawParsed.encryption.sentinel ??= {
      blob: "",
      n: Buffer.alloc(12).toString("base64"),
    };

    rawParsed.encryption.sentinel.blob = Buffer.from([1, 2, 3, 9]).toString("base64");

    await writeFile(vaultPath, JSON.stringify(rawParsed), { encoding: "utf8" });

    v = makeVault();

    await v.loadFromDisk();

    let unlockErr: unknown;
    try {
      await v.unlock({});

    } catch (error) {
      unlockErr = error;
    }

    expect(unlockErr).toBeInstanceOf(VaultCryptoError);
  });

  test("rotateKey keeps ciphertext compatible with sentinel", async () => {
    let v = makeVault();

    await v.loadFromDisk();

    await v.set({ field: "r", service: "s" }, Buffer.from("carry"), nsScope("n", "a"));

    await v.enableEncryption({});

    await v.rotateKey();

    v = await reload();

    await v.unlock({});

    expect(
      (await v.get({ field: "r", service: "s" }, nsScope("n", "a")))!.toString("utf8"),
    ).toBe("carry");
  });

  test("scope hides cross-namespace lookups", async () => {
    let v = makeVault();

    await v.loadFromDisk();

    await v.set({ field: "k", service: "svc" }, Buffer.from("hidden"), nsScope("ns-1", "agent-a"));

    v = await reload();

    const miss = await v.get({ field: "k", service: "svc" }, {

      agentId: "agent-a",

      readableNamespaceIds: ["other"],

    });

    expect(miss).toBeNull();
  });

  test("ambiguous service/field requires default namespace or row id", async () => {
    const v = makeVault();

    await v.loadFromDisk();

    await v.set(
      { field: "token", service: "svc" },
      Buffer.from("a"),
      nsScope("ns-a", "agent"),
    );
    await v.set(
      { field: "token", service: "svc" },
      Buffer.from("b"),
      nsScope("ns-b", "agent"),
    );

    const broadScope: ConnectionScope = {
      agentId: "agent",
      readableNamespaceIds: ["ns-a", "ns-b"],
    };

    let ambiguous: unknown;
    try {
      await v.get({ field: "token", service: "svc" }, broadScope);
    } catch (error) {
      ambiguous = error;
    }

    expect(ambiguous).toBeInstanceOf(VaultScopeError);

    const nsB = await v.get(
      { field: "token", service: "svc" },
      {
        ...broadScope,
        defaultNamespaceId: "ns-b",
      },
    );

    expect(nsB?.toString()).toBe("b");

    // Pick the ns-b row by namespace rather than `list()[0]` — list orders
    // by `updated_at` desc with id as tiebreaker, so back-to-back sets that
    // land in the same millisecond fall through to UUID lex order and make
    // `first` non-deterministic. The intent here is "id-based get bypasses
    // the ambiguity error", not "list returns the newest row first".
    const all = await v.list(broadScope);
    const targetB = all.find((r) => r.metadata.namespace_id === "ns-b");

    expect(targetB).toBeDefined();

    const byId = await v.get(
      { field: "token", id: targetB!.id, service: "svc" },
      broadScope,
    );

    expect(byId?.toString()).toBe("b");
  });

  test("backend sees external disk updates instead of stale lazy cache", async () => {
    const v = makeVault();

    await v.loadFromDisk();

    await v.set({ field: "k", service: "svc" }, Buffer.from("one"), nsScope("n", "a"));

    const other = makeVault();
    await other.loadFromDisk();
    await other.set({ field: "k", service: "svc" }, Buffer.from("two"), nsScope("n", "a"));

    expect(
      (await v.get({ field: "k", service: "svc" }, nsScope("n", "a")))?.toString(),
    ).toBe("two");
  });

  test("delete requires writable scope, not only readable scope", async () => {
    const v = makeVault();

    await v.loadFromDisk();

    await v.set(
      { field: "token", service: "svc" },
      Buffer.from("do-not-delete-from-readable-only-scope"),
      nsScope("source-ns", "agent"),
    );

    const readableOnlyScope: ConnectionScope = {
      agentId: "agent",
      defaultNamespaceId: "target-ns",
      readableNamespaceIds: ["source-ns", "target-ns"],
    };

    let denied: unknown;
    try {
      await v.delete({ field: "token", service: "svc" }, readableOnlyScope);
    } catch (error) {
      denied = error;
    }

    expect(denied).toBeInstanceOf(VaultScopeError);
    expect(
      (await v.get({ field: "token", service: "svc" }, nsScope("source-ns", "agent")))?.toString(),
    ).toBe("do-not-delete-from-readable-only-scope");
  });

  test("expired Connections are hidden from list and unavailable to reads", async () => {
    const v = makeVault();

    await v.loadFromDisk();

    await v.set(
      { field: "token", service: "svc" },
      Buffer.from("expired-secret"),
      nsScope("ns-exp", "agent"),
      { expiresAt: "2000-01-01T00:00:00.000Z" },
    );
    await v.set(
      { field: "token", service: "fresh" },
      Buffer.from("fresh-secret"),
      nsScope("ns-exp", "agent"),
      { expiresAt: "2999-01-01T00:00:00.000Z" },
    );

    const scope = nsScope("ns-exp", "agent");
    expect(await v.get({ field: "token", service: "svc" }, scope)).toBeNull();
    expect(
      (await v.get({ field: "token", service: "fresh" }, scope))?.toString(),
    ).toBe("fresh-secret");

    const listed = await v.list(scope);
    expect(listed.map((row) => row.metadata.service)).toEqual(["fresh"]);
  });

});

async function reload(): Promise<BuiltinVaultBackend> {
  const v = makeVault();

  await v.loadFromDisk();

  return v;
}
