import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { saveCliSession } from "@nautilo/api-client";
import { setActiveProfileResolver } from "../../src/lib/cli-session.ts";
import {
  agentExportModule,
  agentImportModule,
  rejectPassphraseAndPlaintextFlags,
  rejectPassphraseFlag,
  setArgon2idDeriveFn,
  setArtifactStreamIo,
  setBundleIo,
  setPassphraseReader,
} from "../../src/commands/agent.ts";
import {
  decryptProfileBundleFile,
  deriveArtifactSidecarPath,
  deriveDefaultExportFilename,
  encryptProfileBundleFile,
  generateDek,
  headerFromJson,
  parseProfileBundleFile,
  serializeArtifactStream,
  serializeProfileBundleFile,
  createInMemoryArtifactStreamIo,
  asyncReaderFromIterable,
  type ProfileBundleFile,
  type AsyncByteReader,
} from "../../src/lib/profile-bundle.ts";
import type { semantic } from "@nautilo/profile-portability";
import { sha256Hex } from "@nautilo/profile-portability";

// ---------------------------------------------------------------------------
// Deterministic Argon2id stand-in (NOT real Argon2id; same shape as the
// framed-suite test stand-in). Distinct passphrases → distinct KEKs, which is
// all the wrap/unwrap + wrong-passphrase paths need.
// ---------------------------------------------------------------------------

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

const testArgon2id = ({ passphrase, salt, params }: {
  passphrase: Uint8Array;
  salt: Uint8Array;
  params: { memoryCostKiB: number; timeCost: number; parallelism: number; outputLength: number };
}): Uint8Array => {
  const h = createHash("sha256");
  h.update(passphrase);
  h.update(salt);
  h.update(u32be(params.memoryCostKiB));
  h.update(u32be(params.timeCost));
  h.update(u32be(params.parallelism));
  h.update(u32be(params.outputLength));
  return new Uint8Array(h.digest().subarray(0, 32));
};

const PASSPHRASE = "correct horse battery staple";
const WRONG_PASSPHRASE = "wrong passphrase entirely";

// ---------------------------------------------------------------------------
// In-memory filesystem seam
// ---------------------------------------------------------------------------

function createMemoryFs(): { files: Map<string, string>; seams: { write: (p: string, f: ProfileBundleFile) => Promise<void>; read: (p: string) => Promise<ProfileBundleFile> } } {
  const files = new Map<string, string>();
  return {
    files,
    seams: {
      write: async (p, f) => {
        files.set(p, serializeProfileBundleFile(f));
      },
      read: async (p) => {
        const text = files.get(p);
        if (text === undefined) throw new Error(`file not found: ${p}`);
        return parseProfileBundleFile(text);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// stdout/stderr capture
// ---------------------------------------------------------------------------

function captureStd(): { out: string; err: string; restore: () => void; get: () => { out: string; err: string } } {
  let out = "";
  let err = "";
  const wOut = process.stdout.write.bind(process.stdout);
  const wErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array) => {
    out += typeof s === "string" ? s : Buffer.from(s).toString();
    return true;
  };
  process.stderr.write = (s: string | Uint8Array) => {
    err += typeof s === "string" ? s : Buffer.from(s).toString();
    return true;
  };
  return {
    get out() { return out; },
    get err() { return err; },
    get: () => ({ out, err }),
    restore: () => {
      process.stdout.write = wOut;
      process.stderr.write = wErr;
    },
  };
}

// ---------------------------------------------------------------------------
// Fetch router mock for the profile-bundle HTTP surface
// ---------------------------------------------------------------------------

function buildExportResponse(avatarSha: string | null, memoryCount = 0): unknown {
  const records: unknown[] = [
    { recordKind: "identity", name: "Aria", handleIntent: "aria" },
    { recordKind: "soul", text: "A calm, precise assistant." },
    { recordKind: "personality", text: "Warm but concise." },
    { recordKind: "voices", voices: [{ voiceId: "v1", label: "Aria Voice", provider: null, voiceUri: null }] },
    { recordKind: "modelPolicy", policy: { primaryModel: "gpt-x", fallbackModel: null, temperature: null } },
    avatarSha === null
      ? { recordKind: "avatar", avatar: null }
      : { recordKind: "avatar", avatar: { mediaEntry: "media/avatar.bin", mimeType: "image/png", sha256: avatarSha, width: null, height: null } },
    { recordKind: "preferences", preferences: { language: "en", fallbackEnabled: false } },
  ];
  for (let i = 0; i < memoryCount; i += 1) {
    records.push({
      recordKind: "memory",
      scope: "private",
      content: `private memory ${i}`,
      type: "general",
      createdAt: null,
    });
  }
  const scopes: string[] = ["profile", "avatar"];
  if (memoryCount > 0) scopes.push("privateMemories");
  return {
    semanticVersion: { major: 1, minor: 1 },
    bundleId: "source-genie-001",
    scopes,
    records,
    avatarMedia: avatarSha === null ? null : { mediaEntry: "avatar.bin", sha256: avatarSha, mimeType: "image/png", size: 4 },
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeWhoami(instanceId: string): unknown {
  return {
    sessionUserId: "u1",
    sessionActorId: "a1",
    userIdentity: "@aria@local",
    handle: "aria",
    displayName: "Aria",
    externalId: "sub-x",
    instanceId,
    mustChangePassword: false,
    groups: [],
    capabilities: [],
    features: { office: { enabled: false } },
    highestRole: null,
  };
}

function makeFetchRouter(opts: {
  readonly avatarBytes: Uint8Array | null;
  readonly avatarSha: string | null;
  readonly instanceId: string;
  readonly conflicts: unknown[];
  readonly wholeProfileChoice: "source" | "target";
  readonly commitChoice?: "source" | "target";
  readonly planStatus?: number;
  readonly planErrorBody?: unknown;
  readonly stageShouldBeCalled?: boolean;
  readonly exportMemoryCount?: number;
  readonly planMemoryCount?: number;
  readonly planScopes?: readonly string[];
}): typeof fetch {
  const avatarBytes = opts.avatarBytes;
  const planToken = "plan-token-1";
  let staged = false;
  return mock(((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    // Export
    if (url.endsWith("/api/profile/bundle/export") && method === "GET") {
      return Promise.resolve(jsonRes(buildExportResponse(opts.avatarSha, opts.exportMemoryCount ?? 0)));
    }
    if (url.includes("/api/profile/bundle/export/media/") && method === "GET") {
      if (!avatarBytes) return Promise.resolve(jsonRes({ error: "no_custom_avatar" }, 404));
      return Promise.resolve(new Response(avatarBytes, { status: 200, headers: { "Content-Type": "image/png" } }));
    }
    // whoami
    if (url.endsWith("/api/auth/whoami") && method === "GET") {
      return Promise.resolve(jsonRes(makeWhoami(opts.instanceId)));
    }
    // plan
    if (url.endsWith("/api/profile/bundle/import/plan") && method === "POST") {
      if (opts.planStatus && opts.planStatus !== 200) {
        return Promise.resolve(jsonRes(opts.planErrorBody ?? { error: "destination_mismatch" }, opts.planStatus));
      }
      const body = init?.body ? JSON.parse(init.body as string) as { wholeProfileChoice?: string; scopes?: unknown } : {};
      const choice = (body.wholeProfileChoice ?? opts.wholeProfileChoice) as "source" | "target";
      const reqScopes = Array.isArray(body.scopes) ? body.scopes as readonly string[] : (opts.planScopes ?? ["profile", "avatar"]);
      const res = {
        planToken,
        plan: {
          planToken,
          semanticRoot: "r".repeat(64),
          targetStateDigest: "d".repeat(64),
          targetAgentId: "agent-dst",
          destinationInstanceId: opts.instanceId,
          scopes: reqScopes,
          wholeProfileChoice: choice,
          conflicts: opts.conflicts,
          avatarMedia: opts.avatarSha === null ? null : { mediaEntry: "avatar.bin", sha256: opts.avatarSha, mimeType: "image/png" },
          privateMemoryCount: opts.planMemoryCount ?? 0,
          refused: [],
          unknown: [],
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      };
      return Promise.resolve(jsonRes(res));
    }
    // stage
    if (url.includes("/api/profile/bundle/import/stage/") && method === "POST") {
      staged = true;
      if (!avatarBytes) return Promise.resolve(jsonRes({ error: "no_avatar_in_plan" }, 400));
      return Promise.resolve(jsonRes({ planToken, mediaEntry: "avatar.bin", sha256: opts.avatarSha!, size: avatarBytes.length, staged: true as const }));
    }
    // commit
    if (url.endsWith("/api/profile/bundle/import/commit") && method === "POST") {
      const choice = opts.commitChoice ?? opts.wholeProfileChoice;
      if (choice === "source") {
        if (opts.stageShouldBeCalled && !staged && avatarBytes) {
          return Promise.resolve(jsonRes({ error: "avatar_not_staged" }, 409));
        }
        return Promise.resolve(jsonRes({
          planToken,
          idempotencyKey: "idem-1",
          semanticRoot: "r".repeat(64),
          targetStateDigest: "d".repeat(64),
          fresh: true as const,
          committed: true as const,
          choice: "source" as const,
          applied: { name: "Aria", handle: "aria", handleCustomized: true, avatar: avatarBytes ? { kind: "uploaded", blobId: "b1" } : null },
        }));
      }
      return Promise.resolve(jsonRes({
        planToken,
        idempotencyKey: "idem-1",
        semanticRoot: "r".repeat(64),
        targetStateDigest: "d".repeat(64),
        fresh: true as const,
        committed: true as const,
        choice: "target" as const,
      }));
    }
    return Promise.resolve(jsonRes({ error: `unrouted ${method} ${url}` }, 404));
  })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Session helper
// ---------------------------------------------------------------------------

async function seedSession(profile: string): Promise<void> {
  await saveCliSession(
    {
      schemaVersion: 1,
      instanceId: "inst-src",
      serverUrl: "http://127.0.0.1:9999",
      handle: "aria",
      displayName: "Aria",
      externalId: "sub-x",
      accessToken: "tok-aria",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      scopes: [],
      source: "device",
      obtainedAt: Date.now(),
    },
    { profile },
  );
}

const SERVER = "http://127.0.0.1:9999";
const AVATAR = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const AVATAR_SHA = sha256Hex(AVATAR);

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let homeDir: string;

beforeEach(() => {
  process.exitCode = undefined;
  globalThis.fetch = originalFetch;
  homeDir = mkdtempSync(join(tmpdir(), "nautilo-agent-"));
  process.env["NAUTILO_HOME_OVERRIDE"] = homeDir;
  setActiveProfileResolver(() => undefined);
  setPassphraseReader(null);
  setArgon2idDeriveFn(testArgon2id as never);
  setBundleIo(null);
  setArtifactStreamIo(createInMemoryArtifactStreamIo());
  mock.restore();
});

afterEach(() => {
  process.exitCode = undefined;
  globalThis.fetch = originalFetch;
  delete process.env["NAUTILO_HOME_OVERRIDE"];
  setActiveProfileResolver(() => undefined);
  setPassphraseReader(null);
  setArgon2idDeriveFn(null);
  setBundleIo(null);
  setArtifactStreamIo(null);
  rmSync(homeDir, { recursive: true, force: true });
  mock.restore();
});

// ---------------------------------------------------------------------------
// Lib: encrypt → serialize → parse → decrypt round-trip
// ---------------------------------------------------------------------------

describe("profile-bundle lib round-trip", () => {
  test("round-trips records + avatar with the correct passphrase", async () => {
    const records = [
      { recordKind: "identity", name: "Aria", handleIntent: "aria" },
      { recordKind: "soul", text: "calm" },
      { recordKind: "avatar", avatar: { mediaEntry: "media/avatar.bin", mimeType: "image/png", sha256: AVATAR_SHA, width: null, height: null } },
    ];
    const file = await encryptProfileBundleFile({
      records: records as never,
      bundleId: "source-genie-001",
      avatarBytes: AVATAR,
      avatarMedia: { mediaEntry: "avatar.bin", sha256: AVATAR_SHA, mimeType: "image/png" },
      passphrase: new TextEncoder().encode(PASSPHRASE),
      argon2id: testArgon2id as never,
      random: (n) => new Uint8Array(n).fill(7),
    });
    const text = serializeProfileBundleFile(file);
    expect(text).not.toContain(PASSPHRASE);
    expect(file.media).not.toBeNull();
    expect(typeof file.media!.ciphertext).toBe("string");
    expect(typeof file.media!.nonce).toBe("string");
    expect(typeof file.media!.aad).toBe("string");
    expect(text).not.toContain("media/avatar.bin");
    expect(text).not.toContain("image/png");
    expect(text).not.toContain(AVATAR_SHA);
    const parsed = parseProfileBundleFile(text);
    const out = await decryptProfileBundleFile(parsed, new TextEncoder().encode(PASSPHRASE), testArgon2id as never);
    expect(out.records.length).toBe(3);
    expect(out.avatarBytes).not.toBeNull();
    expect(sha256Hex(out.avatarBytes!)).toBe(AVATAR_SHA);
    expect(out.bundle.scopes).toEqual(["profile", "avatar"]);
    expect(out.avatarMedia).toEqual({
      mediaEntry: "media/avatar.bin",
      mimeType: "image/png",
      sha256: AVATAR_SHA,
      size: AVATAR.length,
    });
  });

  test("wrong passphrase is rejected before any server call", async () => {
    const records = [{ recordKind: "identity", name: "Aria", handleIntent: null }];
    const file = await encryptProfileBundleFile({
      records: records as never,
      bundleId: "source-genie-001",
      avatarBytes: null,
      avatarMedia: null,
      passphrase: new TextEncoder().encode(PASSPHRASE),
      argon2id: testArgon2id as never,
      random: (n) => new Uint8Array(n).fill(9),
    });
    let threw = false;
    try {
      await decryptProfileBundleFile(file, new TextEncoder().encode(WRONG_PASSPHRASE), testArgon2id as never);
    } catch (e) {
      threw = true;
      expect((e as Error).name).toBe("WrongPassphraseError");
    }
    expect(threw).toBe(true);
  });

  test("default export filename is name-derived, never vendor-hardcoded", () => {
    const name = deriveDefaultExportFilename([{ recordKind: "identity", name: "Aria Lee", handleIntent: null }]);
    expect(name).toBe("aria-lee.nautilo-profile.json");
    expect(name).not.toContain("jeannie");
  });

  test("rejects malformed hex byte pairs instead of coercing them", async () => {
    const file = await encryptProfileBundleFile({
      records: [{ recordKind: "identity", name: "Aria", handleIntent: null }] as never,
      bundleId: "source-genie-001",
      avatarBytes: null,
      avatarMedia: null,
      passphrase: new TextEncoder().encode(PASSPHRASE),
      argon2id: testArgon2id as never,
      random: (n) => new Uint8Array(n).fill(4),
    });
    const raw = JSON.parse(serializeProfileBundleFile(file)) as { frames: Array<{ ciphertext: string }> };
    raw.frames[0]!.ciphertext = "zz";
    const malformed = parseProfileBundleFile(JSON.stringify(raw));

    let error: unknown;
    try {
      await decryptProfileBundleFile(malformed, new TextEncoder().encode(PASSPHRASE), testArgon2id as never);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toMatch(/invalid hex byte/);
  });

  test("rejects out-of-bounds KDF headers before invoking Argon2id", async () => {
    const file = await encryptProfileBundleFile({
      records: [{ recordKind: "identity", name: "Aria", handleIntent: null }] as never,
      bundleId: "source-genie-001",
      avatarBytes: null,
      avatarMedia: null,
      passphrase: new TextEncoder().encode(PASSPHRASE),
      argon2id: testArgon2id as never,
      random: (n) => new Uint8Array(n).fill(5),
    });
    const raw = JSON.parse(serializeProfileBundleFile(file)) as {
      header: { keySlots: Array<{ kdfParams: { memoryCostKiB: number } }> };
    };
    raw.header.keySlots[0]!.kdfParams.memoryCostKiB = Number.MAX_SAFE_INTEGER;
    const malformed = parseProfileBundleFile(JSON.stringify(raw));
    let kdfCalls = 0;
    const countingKdf = (input: Parameters<typeof testArgon2id>[0]): Uint8Array => {
      kdfCalls += 1;
      return testArgon2id(input);
    };

    let error: unknown;
    try {
      await decryptProfileBundleFile(malformed, new TextEncoder().encode(PASSPHRASE), countingKdf as never);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toMatch(/KDF_PARAM_OUT_OF_BOUNDS/);
    expect(kdfCalls).toBe(0);
  });

  test("rejects malformed frame sequences before invoking Argon2id", async () => {
    const file = await encryptProfileBundleFile({
      records: [{ recordKind: "identity", name: "Aria", handleIntent: null }] as never,
      bundleId: "source-genie-001",
      avatarBytes: null,
      avatarMedia: null,
      passphrase: new TextEncoder().encode(PASSPHRASE),
      argon2id: testArgon2id as never,
      random: (n) => new Uint8Array(n).fill(6),
    });
    const raw = JSON.parse(serializeProfileBundleFile(file)) as { frames: unknown[] };
    raw.frames.pop();
    const malformed = parseProfileBundleFile(JSON.stringify(raw));
    let kdfCalls = 0;
    const countingKdf = (input: Parameters<typeof testArgon2id>[0]): Uint8Array => {
      kdfCalls += 1;
      return testArgon2id(input);
    };

    let error: unknown;
    try {
      await decryptProfileBundleFile(malformed, new TextEncoder().encode(PASSPHRASE), countingKdf as never);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toMatch(/FRAME_MISSING_FINAL/);
    expect(kdfCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Command: export → import dry-run / apply
// ---------------------------------------------------------------------------

async function runHandler(module: { handler: (a: any) => void | Promise<void> }, argv: Record<string, unknown>): Promise<{ out: string; err: string }> {
  const cap = captureStd();
  try {
    await module.handler(argv);
  } finally {
    cap.restore();
  }
  return cap.get();
}

describe("nautilo agent export", () => {
  test("exports an encrypted 0600 bundle with avatar and never logs the passphrase", async () => {
    await seedSession("src");
    setActiveProfileResolver(() => "src");
    setPassphraseReader(async () => PASSPHRASE);
    const mem = createMemoryFs();
    setBundleIo(mem.seams);
    globalThis.fetch = makeFetchRouter({ avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-src", conflicts: [], wholeProfileChoice: "target" });

    const outPath = join(homeDir, "aria.nautilo-profile.json");
    const { out, err } = await runHandler(agentExportModule, { server: SERVER, out: outPath });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("Exported 7 semantic records + custom avatar");
    expect(out).not.toContain(PASSPHRASE);
    expect(err).not.toContain(PASSPHRASE);
    expect(mem.files.has(outPath)).toBe(true);
    // The written file must not contain the passphrase in cleartext.
    expect(mem.files.get(outPath)).not.toContain(PASSPHRASE);
  });

  test("rejects a passphrase supplied by flag", () => {
    expect(() => rejectPassphraseFlag({ passphrase: "x" })).toThrow(/never accepted by flag/);
    expect(rejectPassphraseFlag({})).toBe(true);
  });
});

describe("nautilo agent import", () => {
  async function writeBundleToMem(path: string): Promise<void> {
    const records = [
      { recordKind: "identity", name: "Aria", handleIntent: "aria" },
      { recordKind: "soul", text: "calm" },
      { recordKind: "avatar", avatar: { mediaEntry: "media/avatar.bin", mimeType: "image/png", sha256: AVATAR_SHA, width: null, height: null } },
      { recordKind: "preferences", preferences: { language: "en" } },
    ];
    const file = await encryptProfileBundleFile({
      records: records as never,
      bundleId: "source-genie-001",
      avatarBytes: AVATAR,
      avatarMedia: { mediaEntry: "avatar.bin", sha256: AVATAR_SHA, mimeType: "image/png" },
      passphrase: new TextEncoder().encode(PASSPHRASE),
      argon2id: testArgon2id as never,
      random: (n) => new Uint8Array(n).fill(7),
    });
    const mem = createMemoryFs();
    mem.files.set(path, serializeProfileBundleFile(file));
    setBundleIo(mem.seams);
  }

  test("dry-run prints the plan and makes no changes", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleToMem(bundlePath);

    globalThis.fetch = makeFetchRouter({ avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-dst", conflicts: [], wholeProfileChoice: "target" });

    const { out } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("Dry-run plan");
    expect(out).toContain("no changes; pass --apply to commit");
  });

  test("apply with --on-conflict=source stages avatar and shows the applied result", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleToMem(bundlePath);

    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-dst",
      conflicts: [{ group: "identity", choice: "source" }],
      wholeProfileChoice: "source",
      commitChoice: "source",
      stageShouldBeCalled: true,
    });

    const { out } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath, apply: true, "on-conflict": "source" });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("Staged avatar avatar.bin");
    expect(out).toContain("Applied source profile");
    expect(out).toContain('"Aria"');
  });

  test("apply with --on-conflict=target is a no-op and skips avatar staging", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleToMem(bundlePath);

    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-dst",
      conflicts: [{ group: "identity", choice: "target" }],
      wholeProfileChoice: "target",
      commitChoice: "target",
    });

    const { out } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath, apply: true, "on-conflict": "target" });
    expect(process.exitCode).toBe(0);
    expect(out).not.toContain("Staged avatar");
    expect(out).toContain("choice=target; target profile unchanged");
  });

  test("conflicts without --on-conflict require an explicit choice (exit 2)", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleToMem(bundlePath);

    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-dst",
      conflicts: [{ group: "identity", choice: "source" }],
      wholeProfileChoice: "target",
    });

    const { out, err } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath });
    expect(process.exitCode).toBe(2);
    expect(out).toContain("conflict group(s) detected");
    expect(err).toContain("--on-conflict=source");
  });

  test("destination mismatch surfaces a clean error (exit 2)", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleToMem(bundlePath);

    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-dst",
      conflicts: [],
      wholeProfileChoice: "target",
      planStatus: 409,
      planErrorBody: { error: "destination_mismatch" },
    });

    const { err } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath });
    expect(process.exitCode).toBe(2);
    expect(err).toContain("destination_mismatch");
  });

  test("wrong passphrase fails before any server call (exit 2)", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => WRONG_PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleToMem(bundlePath);

    let whoamiCalled = false;
    globalThis.fetch = mock(((_input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof _input === "string" ? _input : _input instanceof URL ? _input.toString() : _input.url;
      if (url.endsWith("/api/auth/whoami")) whoamiCalled = true;
      return Promise.resolve(jsonRes({}, 404));
    }) as never) as unknown as typeof fetch;

    const { err } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath });
    expect(process.exitCode).toBe(2);
    expect(err).toContain("Wrong passphrase");
    expect(whoamiCalled).toBe(false);
  });

  test("never logs the raw passphrase on import", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleToMem(bundlePath);

    globalThis.fetch = makeFetchRouter({ avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-dst", conflicts: [], wholeProfileChoice: "target" });

    const { out, err } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath });
    expect(out).not.toContain(PASSPHRASE);
    expect(err).not.toContain(PASSPHRASE);
  });

  test("rejects --plaintext and --passphrase flags", () => {
    expect(() => rejectPassphraseAndPlaintextFlags({ plaintext: true })).toThrow(/Plaintext mode is never permitted/);
    expect(() => rejectPassphraseAndPlaintextFlags({ passphrase: "x", plaintext: false })).toThrow(/never accepted by flag/);
    expect(rejectPassphraseAndPlaintextFlags({})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D425 Wave 1B — private memories: default inclusion, opt-out, count-only
// output, and legacy bundle parity.
// ---------------------------------------------------------------------------

describe("nautilo agent export — Wave 1B private memories", () => {
  test("default export includes eligible private memories and reports the count (no content)", async () => {
    await seedSession("src");
    setActiveProfileResolver(() => "src");
    setPassphraseReader(async () => PASSPHRASE);
    const mem = createMemoryFs();
    setBundleIo(mem.seams);
    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-src",
      conflicts: [],
      wholeProfileChoice: "target",
      exportMemoryCount: 3,
    });

    const outPath = join(homeDir, "aria.nautilo-profile.json");
    const { out, err } = await runHandler(agentExportModule, { server: SERVER, out: outPath });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("Exported 7 semantic records + custom avatar + 3 private memories");
    // No memory content / IDs / embeddings leak into CLI output.
    expect(out).not.toContain("private memory 0");
    expect(err).not.toContain("private memory");
    // The written bundle advertises the privateMemories scope and carries the records.
    const parsed = parseProfileBundleFile(mem.files.get(outPath)!);
    const decrypted = await decryptProfileBundleFile(parsed, new TextEncoder().encode(PASSPHRASE), testArgon2id as never);
    expect(decrypted.bundle.scopes).toContain("privateMemories");
    const mems = decrypted.records.filter((r) => r.recordKind === "memory");
    expect(mems.length).toBe(3);
  });

  test("--without-memories strips private memories and writes a Wave 1A-equivalent bundle", async () => {
    await seedSession("src");
    setActiveProfileResolver(() => "src");
    setPassphraseReader(async () => PASSPHRASE);
    const mem = createMemoryFs();
    setBundleIo(mem.seams);
    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-src",
      conflicts: [],
      wholeProfileChoice: "target",
      exportMemoryCount: 2,
    });

    const outPath = join(homeDir, "aria.nautilo-profile.json");
    const { out } = await runHandler(agentExportModule, { server: SERVER, out: outPath, "without-memories": true });
    expect(process.exitCode).toBe(0);
    // Output is byte-for-byte the Wave 1A message: no private-memory clause.
    expect(out).toBe(`Exported 7 semantic records + custom avatar to ${outPath} (mode 0600).\n`);
    expect(out).not.toContain("private mem");
    const parsed = parseProfileBundleFile(mem.files.get(outPath)!);
    const decrypted = await decryptProfileBundleFile(parsed, new TextEncoder().encode(PASSPHRASE), testArgon2id as never);
    expect(decrypted.bundle.scopes).toEqual(["profile", "avatar"]);
    expect(decrypted.records.filter((r) => r.recordKind === "memory").length).toBe(0);
  });

  test("export with no advertised memories is identical to Wave 1A", async () => {
    await seedSession("src");
    setActiveProfileResolver(() => "src");
    setPassphraseReader(async () => PASSPHRASE);
    const mem = createMemoryFs();
    setBundleIo(mem.seams);
    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-src",
      conflicts: [],
      wholeProfileChoice: "target",
      exportMemoryCount: 0,
    });

    const outPath = join(homeDir, "aria.nautilo-profile.json");
    const { out } = await runHandler(agentExportModule, { server: SERVER, out: outPath });
    expect(process.exitCode).toBe(0);
    expect(out).toBe(`Exported 7 semantic records + custom avatar to ${outPath} (mode 0600).\n`);
  });
});

describe("nautilo agent import — Wave 1B private memories", () => {
  async function writeBundleWithMemoriesToMem(path: string, memoryCount: number): Promise<void> {
    const records: unknown[] = [
      { recordKind: "identity", name: "Aria", handleIntent: "aria" },
      { recordKind: "soul", text: "calm" },
      { recordKind: "avatar", avatar: { mediaEntry: "media/avatar.bin", mimeType: "image/png", sha256: AVATAR_SHA, width: null, height: null } },
      { recordKind: "preferences", preferences: { language: "en" } },
    ];
    for (let i = 0; i < memoryCount; i += 1) {
      records.push({
        recordKind: "memory",
        scope: "private",
        content: `private memory ${i}`,
        type: "general",
        createdAt: null,
      });
    }
    const file = await encryptProfileBundleFile({
      records: records as never,
      bundleId: "source-genie-001",
      avatarBytes: AVATAR,
      avatarMedia: { mediaEntry: "avatar.bin", sha256: AVATAR_SHA, mimeType: "image/png" },
      passphrase: new TextEncoder().encode(PASSPHRASE),
      argon2id: testArgon2id as never,
      random: (n) => new Uint8Array(n).fill(7),
    });
    const mem = createMemoryFs();
    mem.files.set(path, serializeProfileBundleFile(file));
    setBundleIo(mem.seams);
  }

  test("dry-run prints the private-memory count only (never content)", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleWithMemoriesToMem(bundlePath, 4);

    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-dst",
      conflicts: [],
      wholeProfileChoice: "target",
      planMemoryCount: 4,
      planScopes: ["profile", "avatar", "privateMemories"],
    });

    const { out } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("private memories: 4");
    expect(out).not.toContain("private memory 0");
    expect(out).toContain("no changes; pass --apply to commit");
  });

  test("apply with --on-conflict=source reports the imported private-memory count only", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleWithMemoriesToMem(bundlePath, 5);

    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-dst",
      conflicts: [{ group: "identity", choice: "source" }],
      wholeProfileChoice: "source",
      commitChoice: "source",
      stageShouldBeCalled: true,
      planMemoryCount: 5,
      planScopes: ["profile", "avatar", "privateMemories"],
    });

    const { out } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath, apply: true, "on-conflict": "source" });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("Applied source profile");
    expect(out).toContain("+ 5 private memories imported");
    expect(out).not.toContain("private memory 0");
  });

  test("legacy bundle (no memories) preserves exact Wave 1A dry-run + apply output", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    await writeBundleWithMemoriesToMem(bundlePath, 0);

    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-dst",
      conflicts: [],
      wholeProfileChoice: "target",
      planMemoryCount: 0,
      planScopes: ["profile", "avatar"],
    });

    const dry = await runHandler(agentImportModule, { server: SERVER, file: bundlePath });
    expect(dry.out).not.toContain("private memories");
    expect(process.exitCode).toBe(0);

    globalThis.fetch = makeFetchRouter({
      avatarBytes: AVATAR,
      avatarSha: AVATAR_SHA,
      instanceId: "inst-dst",
      conflicts: [{ group: "identity", choice: "source" }],
      wholeProfileChoice: "source",
      commitChoice: "source",
      stageShouldBeCalled: true,
      planMemoryCount: 0,
      planScopes: ["profile", "avatar"],
    });

    const apply = await runHandler(agentImportModule, { server: SERVER, file: bundlePath, apply: true, "on-conflict": "source" });
    expect(apply.out).toContain("Applied source profile");
    expect(apply.out).not.toContain("private mem");
  });
});

// ---------------------------------------------------------------------------
// D425 Wave 3 — fetch router mock for the artifact preview/source/stage surface.
// ---------------------------------------------------------------------------

interface ArtifactMock {
  readonly selectionToken: string;
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

function makeArtifactFetchRouter(opts: {
  readonly avatarBytes: Uint8Array | null;
  readonly avatarSha: string | null;
  readonly instanceId: string;
  readonly artifacts: readonly ArtifactMock[];
  readonly conflicts?: readonly unknown[];
  readonly wholeProfileChoice: "source" | "target";
  readonly commitChoice?: "source" | "target";
  readonly planArtifactCount?: number;
  readonly planArtifactBytes?: number;
  readonly planScopes?: readonly string[];
}): typeof fetch {
  const planToken = "plan-token-1";
  const sizeOf = (a: ArtifactMock): number => a.bytes.length;
  return mock(((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/profile/bundle/export") && method === "GET") {
      return Promise.resolve(jsonRes(buildExportResponse(opts.avatarSha, 0)));
    }
    if (url.includes("/api/profile/bundle/export/media/") && method === "GET") {
      if (!opts.avatarBytes) return Promise.resolve(jsonRes({ error: "no_custom_avatar" }, 404));
      return Promise.resolve(new Response(opts.avatarBytes, { status: 200, headers: { "Content-Type": "image/png" } }));
    }
    if (url.endsWith("/api/auth/whoami") && method === "GET") {
      return Promise.resolve(jsonRes(makeWhoami(opts.instanceId)));
    }
    if (url.includes("/api/profile/bundle/artifacts/preview") && method === "GET") {
      const u = new URL(url);
      const limit = Number.parseInt(u.searchParams.get("limit") ?? "100", 10) || 100;
      const offset = Number.parseInt(u.searchParams.get("offset") ?? "0", 10) || 0;
      const page = opts.artifacts.slice(offset, offset + limit);
      const totalBytes = opts.artifacts.reduce((s, a) => s + sizeOf(a), 0);
      return Promise.resolve(jsonRes({
        selectionPlanToken: `sel-plan-${offset}`,
        items: page.map((a) => ({ selectionToken: a.selectionToken, path: a.path, mimeType: a.mimeType, size: sizeOf(a) })),
        totalCount: opts.artifacts.length,
        totalBytes,
        limit,
        offset,
        hasMore: offset + page.length < opts.artifacts.length,
      }));
    }
    if (url.includes("/api/profile/bundle/artifacts/source/") && method === "GET") {
      const u = new URL(url);
      const token = u.pathname.split("/").pop()!;
      const a = opts.artifacts.find((x) => x.selectionToken === token);
      if (!a) return Promise.resolve(jsonRes({ error: "selection_token_unknown" }, 404));
      return Promise.resolve(new Response(a.bytes, { status: 200, headers: { "Content-Type": a.mimeType } }));
    }
    if (url.endsWith("/api/profile/bundle/import/plan") && method === "POST") {
      const body = init?.body ? JSON.parse(init.body as string) as { wholeProfileChoice?: string; scopes?: unknown } : {};
      const choice = (body.wholeProfileChoice ?? opts.wholeProfileChoice) as "source" | "target";
      const reqScopes = Array.isArray(body.scopes) ? body.scopes as readonly string[] : (opts.planScopes ?? ["profile", "avatar"]);
      return Promise.resolve(jsonRes({
        planToken,
        plan: {
          planToken,
          semanticRoot: "r".repeat(64),
          targetStateDigest: "d".repeat(64),
          targetAgentId: "agent-dst",
          destinationInstanceId: opts.instanceId,
          scopes: reqScopes,
          wholeProfileChoice: choice,
          conflicts: opts.conflicts ?? [],
          avatarMedia: opts.avatarSha === null ? null : { mediaEntry: "avatar.bin", sha256: opts.avatarSha, mimeType: "image/png" },
          privateMemoryCount: 0,
          privateArtifactCount: opts.planArtifactCount ?? 0,
          privateArtifactBytes: opts.planArtifactBytes ?? 0,
          refused: [],
          unknown: [],
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }));
    }
    if (url.includes("/api/profile/bundle/import/stage/") && !url.includes("stage-artifact") && method === "POST") {
      if (!opts.avatarBytes) return Promise.resolve(jsonRes({ error: "no_avatar_in_plan" }, 400));
      return Promise.resolve(jsonRes({ planToken, mediaEntry: "avatar.bin", sha256: opts.avatarSha!, size: opts.avatarBytes.length, staged: true as const }));
    }
    if (url.includes("/api/profile/bundle/import/stage-artifact/") && method === "POST") {
      const u = new URL(url);
      const opaqueId = u.pathname.split("/").pop()!;
      const bytesEntry = `media/artifacts/${opaqueId}.bin`;
      const a = opts.artifacts.find((x) => `media/artifacts/${x.selectionToken}.bin` === bytesEntry);
      if (!a) return Promise.resolve(jsonRes({ error: "artifact_token_unknown" }, 404));
      return Promise.resolve(jsonRes({ planToken, bytesEntry, artifactId: `fresh-${opaqueId}`, sha256: sha256Hex(a.bytes), size: sizeOf(a), staged: true as const }));
    }
    if (url.endsWith("/api/profile/bundle/import/commit") && method === "POST") {
      const choice = opts.commitChoice ?? opts.wholeProfileChoice;
      if (choice === "source") {
        return Promise.resolve(jsonRes({
          planToken, idempotencyKey: "idem-1", semanticRoot: "r".repeat(64), targetStateDigest: "d".repeat(64),
          fresh: true as const, committed: true as const, choice: "source" as const,
          applied: { name: "Aria", handle: "aria", handleCustomized: true, avatar: opts.avatarBytes ? { kind: "uploaded", blobId: "b1" } : null },
        }));
      }
      return Promise.resolve(jsonRes({
        planToken, idempotencyKey: "idem-1", semanticRoot: "r".repeat(64), targetStateDigest: "d".repeat(64),
        fresh: true as const, committed: true as const, choice: "target" as const,
      }));
    }
    return Promise.resolve(jsonRes({ error: `unrouted ${method} ${url}` }, 404));
  })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// D425 Wave 3 — export: opt-in preview / selection / streaming.
// ---------------------------------------------------------------------------

const ARTIFACT_A: ArtifactMock = {
  selectionToken: "tok-aaaaaaaa",
  path: "notes/alpha.md",
  mimeType: "text/markdown",
  bytes: new TextEncoder().encode("# alpha\nhello artifact world"),
};
const ARTIFACT_B: ArtifactMock = {
  selectionToken: "tok-bbbbbbbb",
  path: "notes/beta.bin",
  mimeType: "application/octet-stream",
  bytes: crypto.getRandomValues(new Uint8Array(140_000)),
};

describe("nautilo agent export — Wave 3 private artifacts", () => {
  test("--with-artifacts with no selection lists the COMPLETE inventory and exits without writing", async () => {
    await seedSession("src");
    setActiveProfileResolver(() => "src");
    setPassphraseReader(async () => PASSPHRASE);
    const mem = createMemoryFs();
    setBundleIo(mem.seams);
    globalThis.fetch = makeArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-src",
      artifacts: [ARTIFACT_A, ARTIFACT_B], wholeProfileChoice: "target",
    });

    const outPath = join(homeDir, "aria.nautilo-profile.json");
    const { out } = await runHandler(agentExportModule, { server: SERVER, out: outPath, "with-artifacts": true });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("Eligible private artifacts (complete inventory):");
    expect(out).toContain("token=tok-aaaaaaaa path=notes/alpha.md type=text/markdown");
    expect(out).toContain("token=tok-bbbbbbbb path=notes/beta.bin type=application/octet-stream");
    expect(out).toContain("total: 2 artifact(s),");
    expect(out).toContain("No artifacts selected.");
    expect(mem.files.has(outPath)).toBe(false);
    expect(out).not.toContain("artifactInternalId");
    expect(out).not.toContain("storageUri");
  });

  test("--artifacts-all exports a v2 bundle + sidecar with artifact records, count/totals only", async () => {
    await seedSession("src");
    setActiveProfileResolver(() => "src");
    setPassphraseReader(async () => PASSPHRASE);
    const mem = createMemoryFs();
    setBundleIo(mem.seams);
    globalThis.fetch = makeArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-src",
      artifacts: [ARTIFACT_A, ARTIFACT_B], wholeProfileChoice: "target",
    });

    const outPath = join(homeDir, "aria.nautilo-profile.json");
    const { out, err } = await runHandler(agentExportModule, { server: SERVER, out: outPath, "with-artifacts": true, "artifacts-all": true });
    expect(process.exitCode).toBe(0);
    const totalBytes = ARTIFACT_A.bytes.length + ARTIFACT_B.bytes.length;
    expect(out).toContain(`Exported 7 semantic records + custom avatar + 2 private artifacts (${totalBytes} bytes)`);
    expect(out).not.toContain("hello artifact world");
    expect(out).not.toContain("artifactInternalId");
    expect(out).not.toContain("storageUri");
    expect(err).not.toContain(PASSPHRASE);

    const parsed = parseProfileBundleFile(mem.files.get(outPath)!);
    expect(parsed.artifactStream).not.toBeNull();
    expect(parsed.artifactStream!.mediaVersion).toBe(2);
    const decrypted = await decryptProfileBundleFile(parsed, new TextEncoder().encode(PASSPHRASE), testArgon2id as never);
    expect(decrypted.bundle.scopes).toContain("privateArtifacts");
    const arts = decrypted.records.filter(
      (r): r is semantic.PortableArtifact => r.recordKind === "artifact",
    );
    expect(arts.length).toBe(2);
    expect(arts.map((a) => a.bytesEntry).sort()).toEqual(
      ["media/artifacts/tok-aaaaaaaa.bin", "media/artifacts/tok-bbbbbbbb.bin"].sort(),
    );
    expect(arts.every((a) => a.bytesEntry.startsWith("media/artifacts/tok-"))).toBe(true);
    expect(decrypted.bundle.artifactMedia).toEqual({
      mediaVersion: 2,
      entries: arts.map(({ bytesEntry: path, size, sha256 }) => ({ path, size, sha256 })),
    });
  });

  test("--artifacts <token> subset exports only the selected artifact; unknown token fails closed", async () => {
    await seedSession("src");
    setActiveProfileResolver(() => "src");
    setPassphraseReader(async () => PASSPHRASE);
    const mem = createMemoryFs();
    setBundleIo(mem.seams);
    globalThis.fetch = makeArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-src",
      artifacts: [ARTIFACT_A, ARTIFACT_B], wholeProfileChoice: "target",
    });

    const outPath = join(homeDir, "aria.nautilo-profile.json");
    const { out } = await runHandler(agentExportModule, {
      server: SERVER,
      out: outPath,
      "with-artifacts": true,
      "artifact-plan": "sel-plan-0",
      artifacts: ["tok-aaaaaaaa"],
    });
    expect(process.exitCode).toBe(0);
    expect(out).toContain(`Exported 7 semantic records + custom avatar + 1 private artifact (${ARTIFACT_A.bytes.length} bytes)`);
    const parsed = parseProfileBundleFile(mem.files.get(outPath)!);
    const decrypted = await decryptProfileBundleFile(parsed, new TextEncoder().encode(PASSPHRASE), testArgon2id as never);
    const arts = decrypted.records.filter(
      (r): r is semantic.PortableArtifact => r.recordKind === "artifact",
    );
    expect(arts.length).toBe(1);
    expect(arts[0]!.bytesEntry).toBe("media/artifacts/tok-aaaaaaaa.bin");

    globalThis.fetch = makeArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-src",
      artifacts: [ARTIFACT_A, ARTIFACT_B], wholeProfileChoice: "target",
    });
    const { err } = await runHandler(agentExportModule, {
      server: SERVER,
      out: outPath,
      "with-artifacts": true,
      "artifact-plan": "sel-plan-0",
      artifacts: ["tok-zzzzzzzz"],
    });
    expect(process.exitCode).toBe(2);
    expect(err).toContain("unknown artifact selection token");
  });

  test("--artifacts <token> requires the selection plan printed by a prior preview", async () => {
    await seedSession("src");
    setActiveProfileResolver(() => "src");
    globalThis.fetch = makeArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-src",
      artifacts: [ARTIFACT_A], wholeProfileChoice: "target",
    });

    const { err } = await runHandler(agentExportModule, {
      server: SERVER,
      out: join(homeDir, "aria.nautilo-profile.json"),
      "with-artifacts": true,
      artifacts: ["tok-aaaaaaaa"],
    });
    expect(process.exitCode).toBe(2);
    expect(err).toContain("requires --artifact-plan");
  });

  test("default export (no --with-artifacts) is byte-identical to Wave 1B (no artifacts)", async () => {
    await seedSession("src");
    setActiveProfileResolver(() => "src");
    setPassphraseReader(async () => PASSPHRASE);
    const mem = createMemoryFs();
    setBundleIo(mem.seams);
    globalThis.fetch = makeArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-src",
      artifacts: [ARTIFACT_A, ARTIFACT_B], wholeProfileChoice: "target",
    });

    const outPath = join(homeDir, "aria.nautilo-profile.json");
    const { out } = await runHandler(agentExportModule, { server: SERVER, out: outPath });
    expect(process.exitCode).toBe(0);
    expect(out).toBe(`Exported 7 semantic records + custom avatar to ${outPath} (mode 0600).\n`);
    const parsed = parseProfileBundleFile(mem.files.get(outPath)!);
    // No artifacts → the sidecar ref is absent (omitted), keeping the v1/Wave1B
    // bundle byte-identical (the field is not emitted as `null`).
    expect(parsed.artifactStream).toBeUndefined();
    const decrypted = await decryptProfileBundleFile(parsed, new TextEncoder().encode(PASSPHRASE), testArgon2id as never);
    expect(decrypted.bundle.scopes).not.toContain("privateArtifacts");
    expect(decrypted.records.filter((r) => r.recordKind === "artifact").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D425 Wave 3 — import: plan count/totals + stream-decrypt/stage/commit.
// ---------------------------------------------------------------------------

/** A bounded async reader (≤ 64 KiB chunks) for building artifact sources. */
function boundedReader(bytes: Uint8Array, size = 64 * 1024): AsyncByteReader {
  return asyncReaderFromIterable(
    (async function* () {
      for (let off = 0; off < bytes.length; off += size) {
        yield bytes.subarray(off, Math.min(off + size, bytes.length));
      }
    })(),
  );
}

/** Write a bundle + v2 artifact sidecar (in-memory IO) and return the IO. */
async function writeBundleWithArtifactsToMem(
  path: string,
  artifacts: readonly { readonly selectionToken: string; readonly path: string; readonly mimeType: string; readonly bytes: Uint8Array }[],
): Promise<ReturnType<typeof createInMemoryArtifactStreamIo>> {
  const records: unknown[] = [
    { recordKind: "identity", name: "Aria", handleIntent: "aria" },
    { recordKind: "soul", text: "calm" },
    { recordKind: "avatar", avatar: { mediaEntry: "media/avatar.bin", mimeType: "image/png", sha256: AVATAR_SHA, width: null, height: null } },
    { recordKind: "preferences", preferences: { language: "en" } },
  ];
  const portable: semantic.PortableArtifact[] = artifacts.map((a) => ({
    recordKind: "artifact",
    path: a.path,
    mimeType: a.mimeType,
    size: a.bytes.length,
    sha256: sha256Hex(a.bytes),
    bytesEntry: `media/artifacts/${a.selectionToken}.bin`,
  }));
  for (const p of portable) records.push(p);

  const dek = generateDek();
  const file = await encryptProfileBundleFile({
    records: records as never,
    bundleId: "source-genie-001",
    avatarBytes: AVATAR,
    avatarMedia: { mediaEntry: "avatar.bin", sha256: AVATAR_SHA, mimeType: "image/png" },
    passphrase: new TextEncoder().encode(PASSPHRASE),
    argon2id: testArgon2id as never,
    dek,
  });

  const io = createInMemoryArtifactStreamIo();
  setArtifactStreamIo(io);
  const header = headerFromJson(file.header);
  const sidecarPath = deriveArtifactSidecarPath(path);
  const opened = io.openWriter(sidecarPath);
  const sources: { readonly artifact: semantic.PortableArtifact; readonly reader: AsyncByteReader }[] = portable.map((a, i) => ({
    artifact: a,
    reader: boundedReader(artifacts[i]!.bytes),
  }));
  await serializeArtifactStream({ header, dek, sources, writer: opened.writer });
  const summary = opened.summary();

  const finalFile: ProfileBundleFile = {
    ...file,
    artifactStream: { mediaVersion: 2, size: summary.size, sha256: summary.sha256 },
  };
  const mem = createMemoryFs();
  mem.files.set(path, serializeProfileBundleFile(finalFile));
  setBundleIo(mem.seams);
  return io;
}

describe("nautilo agent import — Wave 3 private artifacts", () => {
  test("dry-run prints the private-artifact count + totals only (never content)", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    const arts = [
      { selectionToken: "tok-aaaaaaaa", path: "notes/alpha.md", mimeType: "text/markdown", bytes: new TextEncoder().encode("alpha body") },
      { selectionToken: "tok-bbbbbbbb", path: "notes/beta.bin", mimeType: "application/octet-stream", bytes: new Uint8Array(4096) },
    ];
    await writeBundleWithArtifactsToMem(bundlePath, arts);

    globalThis.fetch = makeArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-dst",
      artifacts: [], conflicts: [], wholeProfileChoice: "target",
      planArtifactCount: 2, planArtifactBytes: arts[0]!.bytes.length + arts[1]!.bytes.length,
      planScopes: ["profile", "avatar", "privateArtifacts"],
    });

    const { out } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("private artifacts: 2");
    expect(out).toContain("bytes)");
    // No artifact content / storage URIs / source ids surface.
    expect(out).not.toContain("alpha body");
    expect(out).not.toContain("storageUri");
    expect(out).not.toContain("artifactInternalId");
    expect(out).toContain("no changes; pass --apply to commit");
  });

  test("apply with --on-conflict=source stream-decrypts, stages, and commits artifacts (count only)", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    const arts = [
      { selectionToken: "tok-aaaaaaaa", path: "notes/alpha.md", mimeType: "text/markdown", bytes: new TextEncoder().encode("alpha body") },
      { selectionToken: "tok-bbbbbbbb", path: "notes/beta.bin", mimeType: "application/octet-stream", bytes: new Uint8Array(4096) },
    ];
    await writeBundleWithArtifactsToMem(bundlePath, arts);

    globalThis.fetch = makeArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-dst",
      artifacts: arts, conflicts: [{ group: "identity", choice: "source" }],
      wholeProfileChoice: "source", commitChoice: "source",
      planArtifactCount: 2, planArtifactBytes: arts[0]!.bytes.length + arts[1]!.bytes.length,
      planScopes: ["profile", "avatar", "privateArtifacts"],
    });

    const { out } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath, apply: true, "on-conflict": "source" });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("Staged avatar avatar.bin");
    expect(out).toContain("Staged 2 private artifacts");
    expect(out).toContain("Applied source profile");
    expect(out).toContain("+ 2 private artifacts imported");
    // No artifact content surfaces in the apply output.
    expect(out).not.toContain("alpha body");
    expect(out).not.toContain("storageUri");
  });

  test("legacy bundle (no artifacts) preserves exact Wave 1B dry-run + apply output", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    // Write a bundle with no artifact records (Wave 1B shape).
    const records: unknown[] = [
      { recordKind: "identity", name: "Aria", handleIntent: "aria" },
      { recordKind: "soul", text: "calm" },
      { recordKind: "avatar", avatar: { mediaEntry: "media/avatar.bin", mimeType: "image/png", sha256: AVATAR_SHA, width: null, height: null } },
      { recordKind: "preferences", preferences: { language: "en" } },
    ];
    const file = await encryptProfileBundleFile({
      records: records as never, bundleId: "source-genie-001",
      avatarBytes: AVATAR, avatarMedia: { mediaEntry: "avatar.bin", sha256: AVATAR_SHA, mimeType: "image/png" },
      passphrase: new TextEncoder().encode(PASSPHRASE), argon2id: testArgon2id as never,
    });
    const mem = createMemoryFs();
    mem.files.set(bundlePath, serializeProfileBundleFile(file));
    setBundleIo(mem.seams);

    globalThis.fetch = makeArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-dst",
      artifacts: [], conflicts: [], wholeProfileChoice: "target",
      planScopes: ["profile", "avatar"],
    });

    const dry = await runHandler(agentImportModule, { server: SERVER, file: bundlePath });
    expect(dry.out).not.toContain("private artifacts");
    expect(process.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D425 Wave 3 (streaming slice) — CLI streaming target-stage sink: proves
// decrypted chunks flow straight into a raw octet-stream request body
// (never a Blob/aggregate buffer), and that terminal errors explicitly clean
// plan artifact staging on the server.
// ---------------------------------------------------------------------------

interface StreamingStageRecorder {
  stageCalls: { opaqueId: string; contentType: string; bodyKind: string; bytes: Uint8Array }[];
  abortCalls: string[];
}

function makeStreamingArtifactFetchRouter(opts: {
  readonly avatarBytes: Uint8Array | null;
  readonly avatarSha: string | null;
  readonly instanceId: string;
  readonly artifacts: readonly ArtifactMock[];
  readonly conflicts?: readonly unknown[];
  readonly wholeProfileChoice: "source" | "target";
  readonly commitChoice?: "source" | "target";
  readonly planArtifactCount?: number;
  readonly planArtifactBytes?: number;
  readonly planScopes?: readonly string[];
  readonly forceChecksumMismatch?: boolean;
  readonly recorder: StreamingStageRecorder;
}): typeof fetch {
  const planToken = "plan-token-1";
  const sizeOf = (a: ArtifactMock): number => a.bytes.length;
  return mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/profile/bundle/export") && method === "GET") {
      return Promise.resolve(jsonRes(buildExportResponse(opts.avatarSha, 0)));
    }
    if (url.includes("/api/profile/bundle/export/media/") && method === "GET") {
      if (!opts.avatarBytes) return Promise.resolve(jsonRes({ error: "no_custom_avatar" }, 404));
      return Promise.resolve(new Response(opts.avatarBytes, { status: 200, headers: { "Content-Type": "image/png" } }));
    }
    if (url.endsWith("/api/auth/whoami") && method === "GET") {
      return Promise.resolve(jsonRes(makeWhoami(opts.instanceId)));
    }
    if (url.endsWith("/api/profile/bundle/import/plan") && method === "POST") {
      const body = init?.body ? (JSON.parse(init.body as string) as { wholeProfileChoice?: string; scopes?: unknown }) : {};
      const choice = (body.wholeProfileChoice ?? opts.wholeProfileChoice) as "source" | "target";
      const reqScopes = Array.isArray(body.scopes) ? (body.scopes as readonly string[]) : (opts.planScopes ?? ["profile", "avatar"]);
      return Promise.resolve(jsonRes({
        planToken,
        plan: {
          planToken,
          semanticRoot: "r".repeat(64),
          targetStateDigest: "d".repeat(64),
          targetAgentId: "agent-dst",
          destinationInstanceId: opts.instanceId,
          scopes: reqScopes,
          wholeProfileChoice: choice,
          conflicts: opts.conflicts ?? [],
          avatarMedia: opts.avatarSha === null ? null : { mediaEntry: "avatar.bin", sha256: opts.avatarSha, mimeType: "image/png" },
          privateMemoryCount: 0,
          privateArtifactCount: opts.planArtifactCount ?? 0,
          privateArtifactBytes: opts.planArtifactBytes ?? 0,
          refused: [],
          unknown: [],
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      }));
    }
    if (url.includes("/api/profile/bundle/import/stage/") && !url.includes("stage-artifact") && method === "POST") {
      if (!opts.avatarBytes) return Promise.resolve(jsonRes({ error: "no_avatar_in_plan" }, 400));
      return Promise.resolve(jsonRes({ planToken, mediaEntry: "avatar.bin", sha256: opts.avatarSha!, size: opts.avatarBytes.length, staged: true as const }));
    }
    if (url.includes("/api/profile/bundle/import/stage-artifact/") && method === "POST") {
      const u = new URL(url);
      const opaqueId = u.pathname.split("/").pop()!;
      const bytesEntry = `media/artifacts/${opaqueId}.bin`;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
      const bodyKind = init?.body instanceof ReadableStream ? "ReadableStream"
        : init?.body instanceof Blob ? "Blob"
        : init?.body instanceof FormData ? "FormData"
        : typeof init?.body;
      let bytes = new Uint8Array(0);
      if (init?.body instanceof ReadableStream) {
        bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      } else if (init?.body instanceof Blob) {
        bytes = new Uint8Array(await init.body.arrayBuffer());
      }
      opts.recorder.stageCalls.push({ opaqueId, contentType, bodyKind, bytes });
      const a = opts.artifacts.find((x) => `media/artifacts/${x.selectionToken}.bin` === bytesEntry);
      if (!a) return Promise.resolve(jsonRes({ error: "artifact_token_unknown" }, 404));
      if (opts.forceChecksumMismatch === true) {
        return Promise.resolve(jsonRes({ error: "artifact_checksum_mismatch", code: "artifact_checksum_mismatch", bytesEntry }, 400));
      }
      return Promise.resolve(jsonRes({ planToken, bytesEntry, artifactId: `fresh-${opaqueId}`, sha256: sha256Hex(a.bytes), size: sizeOf(a), staged: true as const }));
    }
    if (method === "DELETE" && url.includes("/api/profile/bundle/import/stage-artifact")) {
      const u = new URL(url);
      const pt = u.searchParams.get("planToken") ?? "";
      opts.recorder.abortCalls.push(pt);
      return Promise.resolve(jsonRes({ planToken: pt, cleared: 0, clearedAll: true as const }));
    }
    if (url.endsWith("/api/profile/bundle/import/commit") && method === "POST") {
      const choice = opts.commitChoice ?? opts.wholeProfileChoice;
      if (choice === "source") {
        return Promise.resolve(jsonRes({
          planToken, idempotencyKey: "idem-1", semanticRoot: "r".repeat(64), targetStateDigest: "d".repeat(64),
          fresh: true as const, committed: true as const, choice: "source" as const,
          applied: { name: "Aria", handle: "aria", handleCustomized: true, avatar: opts.avatarBytes ? { kind: "uploaded", blobId: "b1" } : null },
        }));
      }
      return Promise.resolve(jsonRes({
        planToken, idempotencyKey: "idem-1", semanticRoot: "r".repeat(64), targetStateDigest: "d".repeat(64),
        fresh: true as const, committed: true as const, choice: "target" as const,
      }));
    }
    return Promise.resolve(jsonRes({ error: `unrouted ${method} ${url}` }, 404));
  }) as unknown as typeof fetch;
}

describe("nautilo agent import — Wave 3 streaming artifact stage (streaming slice)", () => {
  test("streaming stage: bounded chunks flow to the request body as octet-stream (no Blob/FormData aggregate)", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    // A large artifact (> 64 KiB) so the deserializer yields MULTIPLE bounded
    // chunks, proving they flow chunk-by-chunk into the request body.
    const big = crypto.getRandomValues(new Uint8Array(140_000));
    const arts = [
      { selectionToken: "tok-aaaaaaaa", path: "notes/alpha.md", mimeType: "text/markdown", bytes: new TextEncoder().encode("alpha body") },
      { selectionToken: "tok-bbbbbbbb", path: "notes/beta.bin", mimeType: "application/octet-stream", bytes: big },
    ];
    await writeBundleWithArtifactsToMem(bundlePath, arts);

    const recorder: StreamingStageRecorder = { stageCalls: [], abortCalls: [] };
    globalThis.fetch = makeStreamingArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-dst",
      artifacts: arts, conflicts: [{ group: "identity", choice: "source" }],
      wholeProfileChoice: "source", commitChoice: "source",
      planArtifactCount: 2, planArtifactBytes: arts[0]!.bytes.length + arts[1]!.bytes.length,
      planScopes: ["profile", "avatar", "privateArtifacts"],
      recorder,
    });

    const { out } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath, apply: true, "on-conflict": "source" });
    expect(process.exitCode).toBe(0);
    expect(out).toContain("Staged 2 private artifacts");
    expect(out).toContain("Applied source profile");
    // Two streaming stage requests, one per artifact.
    expect(recorder.stageCalls).toHaveLength(2);
    expect(recorder.abortCalls).toHaveLength(0);
    for (const call of recorder.stageCalls) {
      expect(call.contentType).toBe("application/octet-stream");
      expect(call.bodyKind).toBe("ReadableStream");
    }
    // The large artifact's bytes arrived intact through the stream (reassembled).
    const bigCall = recorder.stageCalls.find((c) => c.opaqueId === "tok-bbbbbbbb")!;
    expect(bigCall.bytes.length).toBe(big.length);
    expect(Array.from(bigCall.bytes)).toEqual(Array.from(big));
  });

  test("checksum/size failure cleanup path: server 400 → CLI aborts in-flight streams and calls the plan cleanup endpoint", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    const arts = [
      { selectionToken: "tok-aaaaaaaa", path: "notes/alpha.md", mimeType: "text/markdown", bytes: new TextEncoder().encode("alpha body") },
    ];
    await writeBundleWithArtifactsToMem(bundlePath, arts);

    const recorder: StreamingStageRecorder = { stageCalls: [], abortCalls: [] };
    globalThis.fetch = makeStreamingArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-dst",
      artifacts: arts, conflicts: [{ group: "identity", choice: "source" }],
      wholeProfileChoice: "source", commitChoice: "source",
      planArtifactCount: 1, planArtifactBytes: arts[0]!.bytes.length,
      planScopes: ["profile", "avatar", "privateArtifacts"],
      forceChecksumMismatch: true,
      recorder,
    });

    const { out, err } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath, apply: true, "on-conflict": "source" });
    expect(process.exitCode).toBe(2);
    // The streaming stage request WAS made (octet-stream body), then the
    // plan cleanup endpoint WAS called explicitly.
    expect(recorder.stageCalls).toHaveLength(1);
    expect(recorder.stageCalls[0]!.contentType).toBe("application/octet-stream");
    expect(recorder.stageCalls[0]!.bodyKind).toBe("ReadableStream");
    expect(recorder.abortCalls).toEqual(["plan-token-1"]);
    // The error surfaces as a bundle file error; commit never ran.
    expect(out + err).toMatch(/artifact staging failed|artifact_checksum_mismatch/);
    expect(out).not.toContain("Applied source profile");
  });

  test("terminal manifest failure cleanup path: a truncated sidecar → CLI calls the plan cleanup endpoint and surfaces the error", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    const arts = [
      { selectionToken: "tok-aaaaaaaa", path: "notes/alpha.md", mimeType: "text/markdown", bytes: new TextEncoder().encode("alpha body") },
    ];
    const io = await writeBundleWithArtifactsToMem(bundlePath, arts);
    // Truncate the sidecar's last byte so the terminal-manifest frame is
    // unreadable → the deserializer throws a terminal error AFTER chunk
    // frames have been fed to the sink (in-flight stage requests exist).
    const sidecarPath = deriveArtifactSidecarPath(bundlePath);
    const wire = io.store.get(sidecarPath)!;
    io.store.set(sidecarPath, wire.subarray(0, wire.length - 1));

    const recorder: StreamingStageRecorder = { stageCalls: [], abortCalls: [] };
    globalThis.fetch = makeStreamingArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-dst",
      artifacts: arts, conflicts: [{ group: "identity", choice: "source" }],
      wholeProfileChoice: "source", commitChoice: "source",
      planArtifactCount: 1, planArtifactBytes: arts[0]!.bytes.length,
      planScopes: ["profile", "avatar", "privateArtifacts"],
      recorder,
    });

    const { out, err } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath, apply: true, "on-conflict": "source" });
    expect(process.exitCode).toBe(2);
    // The plan cleanup endpoint WAS called explicitly despite the manifest
    // error; commit never ran.
    expect(recorder.abortCalls).toEqual(["plan-token-1"]);
    expect(out).not.toContain("Applied source profile");
    expect(out + err).toMatch(/Bundle file error|artifact stream/);
  });

  test("v1/Wave1B unchanged: a bundle with NO artifacts never opens a streaming stage request", async () => {
    await seedSession("dst");
    setActiveProfileResolver(() => "dst");
    setPassphraseReader(async () => PASSPHRASE);
    const bundlePath = join(homeDir, "aria.nautilo-profile.json");
    // Wave 1B shape: no artifact records, no sidecar.
    const records: unknown[] = [
      { recordKind: "identity", name: "Aria", handleIntent: "aria" },
      { recordKind: "soul", text: "calm" },
      { recordKind: "avatar", avatar: { mediaEntry: "media/avatar.bin", mimeType: "image/png", sha256: AVATAR_SHA, width: null, height: null } },
      { recordKind: "preferences", preferences: { language: "en" } },
    ];
    const file = await encryptProfileBundleFile({
      records: records as never, bundleId: "source-genie-001",
      avatarBytes: AVATAR, avatarMedia: { mediaEntry: "avatar.bin", sha256: AVATAR_SHA, mimeType: "image/png" },
      passphrase: new TextEncoder().encode(PASSPHRASE), argon2id: testArgon2id as never,
    });
    const mem = createMemoryFs();
    mem.files.set(bundlePath, serializeProfileBundleFile(file));
    setBundleIo(mem.seams);

    const recorder: StreamingStageRecorder = { stageCalls: [], abortCalls: [] };
    globalThis.fetch = makeStreamingArtifactFetchRouter({
      avatarBytes: AVATAR, avatarSha: AVATAR_SHA, instanceId: "inst-dst",
      artifacts: [], conflicts: [], wholeProfileChoice: "target",
      planScopes: ["profile", "avatar"],
      recorder,
    });

    const { out } = await runHandler(agentImportModule, { server: SERVER, file: bundlePath, apply: true, "on-conflict": "target" });
    expect(process.exitCode).toBe(0);
    // No streaming stage request and no cleanup call — the streaming sink
    // is never constructed for a bundle without artifact records.
    expect(recorder.stageCalls).toHaveLength(0);
    expect(recorder.abortCalls).toHaveLength(0);
    expect(out).toContain("Committed with choice=target");
  });
});
