/* eslint-disable @typescript-eslint/await-thenable -- Bun promise matchers are awaited at runtime. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MINI_APP_RECOVERY_VERSION,
  parseMiniAppRecoveryOpenInput,
  parseMiniAppRecoveryWriteInput,
  type MiniAppRecoveryBinding,
  type MiniAppRecoveryDraft,
} from "../../electron/mini-app-draft-recovery-contract";
import {
  MiniAppDraftRecoveryRuntime,
  MiniAppDraftRecoveryStore,
  MiniAppRecoveryError,
  resolveMiniAppRecoveryFilePath,
  type MiniAppRecoverySafeStorage,
} from "../../electron/mini-app-draft-recovery";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter";

let root = "";
const desktopRoot = path.join(import.meta.dir, "../..");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-mini-app-recovery-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function protectedStorage(
  available = true,
  backend = "keychain",
): MiniAppRecoverySafeStorage {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`, "utf8"),
    decryptString: (value) => Buffer.from(
      value.toString("utf8").replace(/^sealed:/, ""),
      "base64",
    ).toString("utf8"),
  };
}

const binding: MiniAppRecoveryBinding = {
  owner: {
    humanId: "human-17",
    canonicalOrigin: "https://draft.example.test",
    serverFingerprint: "sha256/fingerprint-17",
  },
  appId: "nautilo-presentation",
  target: {
    kind: "workspace_artifact",
    artifactInternalId: "123e4567-e89b-42d3-a456-426614174000",
  },
};

const draft: MiniAppRecoveryDraft = {
  version: MINI_APP_RECOVERY_VERSION,
  content: "<html>private unsaved slide</html>",
  exact: true,
  baseSha256: "a".repeat(64),
  baseRevision: 7,
};

function makeStore(options: {
  storage?: MiniAppRecoverySafeStorage;
  revisions?: string[];
  onBeforeAtomicPublish?: () => void | Promise<void>;
  onBeforeReadReturn?: () => void | Promise<void>;
} = {}): MiniAppDraftRecoveryStore {
  const revisions = options.revisions ?? ["revision-1", "revision-2", "revision-3"];
  return new MiniAppDraftRecoveryStore({
    rootDir: root,
    safeStorage: options.storage ?? protectedStorage(),
    mintRevision: () => revisions.shift() ?? "revision-next",
    onBeforeAtomicPublish: options.onBeforeAtomicPublish,
    onBeforeReadReturn: options.onBeforeReadReturn,
  });
}

describe("mini-app draft recovery contract", () => {
  test("accepts only the allowlisted app and exact target/write shapes", () => {
    expect(parseMiniAppRecoveryOpenInput({
      expectedViewerId: "human-17",
      appId: "nautilo-presentation",
      target: {
        kind: "workspace_artifact",
        artifactInternalId: "123e4567-e89b-42d3-a456-426614174000",
      },
    })).not.toBeNull();
    expect(parseMiniAppRecoveryOpenInput({
      expectedViewerId: "human-17",
      appId: "nautilo-board",
      target: {
        kind: "workspace_artifact",
        artifactInternalId: "123e4567-e89b-42d3-a456-426614174000",
      },
    })).not.toBeNull();
    expect(parseMiniAppRecoveryOpenInput({
      expectedViewerId: "human-17",
      appId: "nautilo-writer",
      target: {
        kind: "workspace_artifact",
        artifactInternalId: "123e4567-e89b-42d3-a456-426614174000",
      },
    })).toBeNull();
    expect(parseMiniAppRecoveryWriteInput({ expectedRevision: null, draft })).toEqual({
      expectedRevision: null,
      draft,
    });
    expect(parseMiniAppRecoveryWriteInput({
      expectedRevision: null,
      draft: { ...draft, unknown: true },
    })).toBeNull();
  });
});

describe("mini-app draft recovery native bridge", () => {
  test("authenticates open online while read/write remain local and account changes revoke", () => {
    const main = fs.readFileSync(path.join(desktopRoot, "electron/main.ts"), "utf8");
    const preload = fs.readFileSync(path.join(desktopRoot, "electron/preload.ts"), "utf8");
    const openStart = main.indexOf('ipcMain.handle("miniAppRecovery:open"');
    const readStart = main.indexOf('ipcMain.handle("miniAppRecovery:read"');
    const writeStart = main.indexOf('ipcMain.handle("miniAppRecovery:write"');
    const closeStart = main.indexOf('ipcMain.handle("miniAppRecovery:close"');
    expect(main.slice(openStart, readStart)).toContain("resolveReadyToWorkBindingForSession(session)");
    expect(main.slice(readStart, writeStart)).not.toContain("resolveReadyToWorkBindingForSession");
    expect(main.slice(writeStart, closeStart)).not.toContain("resolveReadyToWorkBindingForSession");
    expect(preload).toContain('ipcRenderer.invoke("miniAppRecovery:open", input)');
    expect(preload).toContain('ipcRenderer.invoke("miniAppRecovery:write", { handle, input })');

    const candidateStart = main.indexOf("async function authenticateConnectionCandidate(");
    const candidateEnd = main.indexOf("const desktopConnectionFlow", candidateStart);
    const candidate = main.slice(candidateStart, candidateEnd);
    const storedCredentials = candidate.slice(0, candidate.indexOf("let authSurface:"));
    const freshCredentials = candidate.slice(candidate.indexOf("let authSurface:"));
    expect(storedCredentials).not.toContain("invalidateMiniAppRecoveryAuthentication()");
    expect(freshCredentials).toContain("invalidateMiniAppRecoveryAuthentication()");
    const retireStart = main.indexOf("retireStoredCandidateIdentity:");
    const retireEnd = main.indexOf("commitActiveAuthority:", retireStart);
    expect(main.slice(retireStart, retireEnd)).toContain("invalidateMiniAppRecoveryAuthentication()");
  });
});

describe("MiniAppDraftRecoveryStore", () => {
  test("a moved file retains its old-path journal while the current grant remains valid", async () => {
    const documents = path.join(root, "documents");
    fs.mkdirSync(documents);
    const original = path.join(documents, "deck.presentation.html");
    fs.writeFileSync(original, "saved deck");
    const files = createGuardedNodeAdapter({ allowedRoots: [documents] });
    const canonicalPath = await resolveMiniAppRecoveryFilePath(files, original);
    const localBinding: MiniAppRecoveryBinding = { ...binding, target: { kind: "local_file", relayId: "local-relay", canonicalPath } };
    await makeStore().write(localBinding, null, draft);
    fs.renameSync(original, path.join(documents, "renamed.presentation.html"));
    expect(await resolveMiniAppRecoveryFilePath(files, original)).toBe(canonicalPath);
    expect((await makeStore().read(localBinding)).draft).toEqual(draft);
    expect(fs.existsSync(original)).toBe(false);

    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    const revoked = createGuardedNodeAdapter({ allowedRoots: [elsewhere] });
    await expect(resolveMiniAppRecoveryFilePath(revoked, original)).rejects.toThrow();
  });

  test("recovery refuses a symlink or directory replacing the missing original", async () => {
    const files = createGuardedNodeAdapter({ allowedRoots: [root] });
    const original = path.join(root, "deck.presentation.html");
    const replacement = path.join(root, "replacement.html");
    fs.writeFileSync(replacement, "unrelated document");
    fs.symlinkSync(replacement, original);
    await expect(resolveMiniAppRecoveryFilePath(files, original)).rejects.toThrow();
    fs.unlinkSync(original);
    fs.mkdirSync(original);
    await expect(resolveMiniAppRecoveryFilePath(files, original)).rejects.toThrow();
  });

  test("persists protected bytes atomically and restores them in a new store", async () => {
    const store = makeStore({ revisions: ["revision-1"] });
    await expect(store.read(binding)).resolves.toEqual({ revision: null, draft: null });
    await expect(store.write(binding, null, draft)).resolves.toEqual({ revision: "revision-1" });

    const files = fs.readdirSync(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.bin$/);
    const bytes = fs.readFileSync(path.join(root, files[0]!));
    expect(bytes.toString("utf8")).not.toContain(draft.content);
    if (process.platform !== "win32") {
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(root, files[0]!)).mode & 0o777).toBe(0o600);
    }

    const restarted = makeStore();
    await expect(restarted.read(binding)).resolves.toEqual({ revision: "revision-1", draft });
  });

  test("serializes CAS writes and retains a revisioned tombstone", async () => {
    const store = makeStore({ revisions: ["revision-a", "revision-b", "revision-c"] });
    const results = await Promise.allSettled([
      store.write(binding, null, draft),
      store.write(binding, null, { ...draft, content: "other" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(MiniAppRecoveryError);

    const current = await store.read(binding);
    expect(current.revision).toBe("revision-a");
    await expect(store.write(binding, current.revision, null)).resolves.toEqual({
      revision: "revision-b",
    });
    await expect(store.read(binding)).resolves.toEqual({ revision: "revision-b", draft: null });
    await expect(makeStore().read(binding)).resolves.toEqual({ revision: "revision-b", draft: null });
    await expect(store.write(binding, null, draft)).rejects.toMatchObject({ code: "conflict" });
  });

  test("isolates app, owner, authority, and target scopes", async () => {
    const store = makeStore({ revisions: ["revision-1", "revision-2"] });
    await store.write(binding, null, draft);
    await expect(store.read({
      ...binding,
      owner: { ...binding.owner, humanId: "human-18" },
    })).resolves.toEqual({ revision: null, draft: null });
    await expect(store.read({
      ...binding,
      owner: { ...binding.owner, serverFingerprint: "sha256/fingerprint-18" },
    })).resolves.toEqual({ revision: null, draft: null });
    await expect(store.read({
      ...binding,
      appId: "nautilo-board",
    })).resolves.toEqual({ revision: null, draft: null });
    await expect(store.read({
      ...binding,
      target: {
        kind: "workspace_artifact",
        artifactInternalId: "223e4567-e89b-42d3-a456-426614174000",
      },
    })).resolves.toEqual({ revision: null, draft: null });
  });

  test("fails closed without OS protection and retains corrupt bytes", async () => {
    const unavailable = makeStore({ storage: protectedStorage(false) });
    await expect(unavailable.write(binding, null, draft)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fs.readdirSync(root)).toEqual([]);

    const basicText = makeStore({ storage: protectedStorage(true, "basic_text") });
    await expect(basicText.read(binding)).rejects.toMatchObject({ code: "unavailable" });

    const store = makeStore({ revisions: ["revision-1"] });
    await store.write(binding, null, draft);
    const filePath = path.join(root, fs.readdirSync(root)[0]!);
    fs.writeFileSync(filePath, "corrupt protected record", { mode: 0o600 });
    await expect(store.read(binding)).rejects.toMatchObject({ code: "invalid" });
    expect(fs.readFileSync(filePath, "utf8")).toBe("corrupt protected record");
  });

  test("rejects a validly encrypted draft whose content checksum no longer matches", async () => {
    const store = makeStore({ revisions: ["revision-1"] });
    await store.write(binding, null, draft);
    const filePath = path.join(root, fs.readdirSync(root)[0]!);
    const protectedBytes = fs.readFileSync(filePath);
    const sealedMarker = protectedBytes.indexOf(Buffer.from("sealed:", "utf8"));
    expect(sealedMarker).toBeGreaterThan(0);
    const encryptedJson = protectedBytes.subarray(sealedMarker + "sealed:".length);
    const envelope = JSON.parse(Buffer.from(encryptedJson.toString("utf8"), "base64").toString("utf8")) as {
      draft: { content: string };
    };
    envelope.draft.content = "tampered but still valid JSON";
    const tampered = Buffer.concat([
      protectedBytes.subarray(0, sealedMarker),
      Buffer.from(`sealed:${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64")}`, "utf8"),
    ]);
    fs.writeFileSync(filePath, tampered, { mode: 0o600 });

    await expect(store.read(binding)).rejects.toMatchObject({ code: "invalid" });
    expect(fs.readFileSync(filePath)).toEqual(tampered);
  });
});

describe("MiniAppDraftRecoveryRuntime", () => {
  const context = {
    senderId: 41,
    authGeneration: 3,
    canonicalOrigin: binding.owner.canonicalOrigin,
    serverFingerprint: binding.owner.serverFingerprint,
    signedIn: true,
  } as const;

  test("binds opaque handles to sender, auth generation, and server authority", async () => {
    const runtime = new MiniAppDraftRecoveryRuntime({
      store: makeStore({ revisions: ["revision-1"] }),
      mintHandle: () => "opaque-handle",
    });
    const handle = runtime.open(context.senderId, context.authGeneration, binding);
    await expect(runtime.write(context, handle, null, draft)).resolves.toEqual({
      revision: "revision-1",
    });
    await expect(runtime.read({ ...context, senderId: 42 }, handle)).rejects.toMatchObject({
      code: "authority_changed",
    });
    await expect(runtime.read(context, handle)).resolves.toEqual({
      revision: "revision-1",
      draft,
    });
  });

  test("revokes handles on auth changes, sender destruction, and close", async () => {
    let nextHandle = 0;
    const runtime = new MiniAppDraftRecoveryRuntime({
      store: makeStore(),
      mintHandle: () => `handle-${++nextHandle}`,
    });

    const authHandle = runtime.open(context.senderId, context.authGeneration, binding);
    await expect(runtime.read({ ...context, authGeneration: 4 }, authHandle)).rejects.toMatchObject({
      code: "authority_changed",
    });

    const senderHandle = runtime.open(context.senderId, context.authGeneration, binding);
    runtime.invalidateSender(context.senderId);
    await expect(runtime.read(context, senderHandle)).rejects.toMatchObject({
      code: "authority_changed",
    });

    const closedHandle = runtime.open(context.senderId, context.authGeneration, binding);
    await runtime.close(context.senderId, closedHandle);
    await expect(runtime.read(context, closedHandle)).rejects.toMatchObject({
      code: "authority_changed",
    });
  });

  test("keeps a handle through an outage but rejects logout and server replacement", async () => {
    let nextHandle = 0;
    const runtime = new MiniAppDraftRecoveryRuntime({
      store: makeStore({ revisions: ["revision-1"] }),
      mintHandle: () => `handle-${++nextHandle}`,
    });
    const offlineHandle = runtime.open(context.senderId, context.authGeneration, binding);
    await runtime.write(context, offlineHandle, null, draft);
    // There is intentionally no transport/connection field in the local handle
    // context. An ordinary server outage does not revoke authenticated custody.
    await expect(runtime.read(context, offlineHandle)).resolves.toEqual({
      revision: "revision-1",
      draft,
    });

    const logoutHandle = runtime.open(context.senderId, context.authGeneration, binding);
    await expect(runtime.read({ ...context, signedIn: false }, logoutHandle)).rejects.toMatchObject({
      code: "authority_changed",
    });

    const replacementHandle = runtime.open(context.senderId, context.authGeneration, binding);
    await expect(runtime.read({
      ...context,
      serverFingerprint: "sha256/replacement",
    }, replacementHandle)).rejects.toMatchObject({ code: "authority_changed" });
  });

  test("a closed queued handle cannot publish after an earlier write releases the scope lane", async () => {
    let releaseFirstPublish!: () => void;
    let observeFirstPublish!: () => void;
    const firstPublishObserved = new Promise<void>((resolve) => { observeFirstPublish = resolve; });
    const releaseFirst = new Promise<void>((resolve) => { releaseFirstPublish = resolve; });
    let publishCount = 0;
    let nextHandle = 0;
    const runtime = new MiniAppDraftRecoveryRuntime({
      store: makeStore({
        revisions: ["revision-first", "revision-stale"],
        onBeforeAtomicPublish: async () => {
          publishCount += 1;
          if (publishCount === 1) {
            observeFirstPublish();
            await releaseFirst;
          }
        },
      }),
      mintHandle: () => `handle-${++nextHandle}`,
    });
    const firstHandle = runtime.open(context.senderId, context.authGeneration, binding);
    const queuedHandle = runtime.open(context.senderId, context.authGeneration, binding);
    const firstWrite = runtime.write(context, firstHandle, null, draft);
    await firstPublishObserved;
    const queuedWrite = runtime.write(
      context,
      queuedHandle,
      null,
      { ...draft, content: "must not publish" },
    );
    const queuedOutcome = queuedWrite.then(
      () => null,
      (error: unknown) => error,
    );
    const closing = runtime.close(context.senderId, queuedHandle);
    releaseFirstPublish();

    await expect(firstWrite).resolves.toEqual({ revision: "revision-first" });
    await expect(closing).resolves.toBeUndefined();
    await expect(queuedOutcome).resolves.toMatchObject({ code: "authority_changed" });
    await expect(runtime.read(context, firstHandle)).resolves.toEqual({
      revision: "revision-first",
      draft,
    });
    expect(publishCount).toBe(1);
  });

  test("revocation during an awaited read prevents decrypted draft disclosure", async () => {
    let releaseRead!: () => void;
    let observeRead!: () => void;
    const readObserved = new Promise<void>((resolve) => { observeRead = resolve; });
    const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
    const store = makeStore({
      revisions: ["revision-1"],
      onBeforeReadReturn: async () => {
        observeRead();
        await readRelease;
      },
    });
    await store.write(binding, null, draft);
    const runtime = new MiniAppDraftRecoveryRuntime({
      store,
      mintHandle: () => "delayed-read-handle",
    });
    const handle = runtime.open(context.senderId, context.authGeneration, binding);
    const read = runtime.read(context, handle);
    const outcome = read.then(() => null, (error: unknown) => error);
    await readObserved;
    runtime.invalidateAll();
    releaseRead();
    await expect(outcome).resolves.toMatchObject({ code: "authority_changed" });
  });

  test("dynamic local authority is rechecked immediately before publication", async () => {
    const localBinding: MiniAppRecoveryBinding = {
      ...binding,
      target: {
        kind: "local_file",
        relayId: "relay-17",
        canonicalPath: "/allowed/deck.presentation.html",
      },
    };
    let authorized = true;
    const runtime = new MiniAppDraftRecoveryRuntime({
      store: makeStore({
        revisions: ["must-not-publish"],
        onBeforeAtomicPublish: () => { authorized = false; },
      }),
      mintHandle: () => "local-authority-handle",
      authorizeBinding: () => authorized,
    });
    const handle = runtime.open(context.senderId, context.authGeneration, localBinding);
    await expect(runtime.write(context, handle, null, draft)).rejects.toMatchObject({
      code: "authority_changed",
    });
    authorized = true;
    await expect(makeStore().read(localBinding)).resolves.toEqual({ revision: null, draft: null });
  });

  test("close during awaited target authorization prevents publication", async () => {
    let releaseAuthorization!: () => void;
    let observeAuthorization!: () => void;
    const authorizationObserved = new Promise<void>((resolve) => { observeAuthorization = resolve; });
    const authorizationRelease = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    let authorizationCount = 0;
    const runtime = new MiniAppDraftRecoveryRuntime({
      store: makeStore({ revisions: ["must-not-publish"] }),
      mintHandle: () => "delayed-authorization-handle",
      authorizeBinding: async () => {
        authorizationCount += 1;
        if (authorizationCount === 3) {
          observeAuthorization();
          await authorizationRelease;
        }
        return true;
      },
    });
    const handle = runtime.open(context.senderId, context.authGeneration, binding);
    const write = runtime.write(context, handle, null, draft);
    const writeOutcome = write.then(() => null, (error: unknown) => error);
    await authorizationObserved;
    const closing = runtime.close(context.senderId, handle);
    releaseAuthorization();
    await expect(writeOutcome).resolves.toMatchObject({ code: "authority_changed" });
    await expect(closing).resolves.toBeUndefined();
    await expect(makeStore().read(binding)).resolves.toEqual({ revision: null, draft: null });
  });
});
