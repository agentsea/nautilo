/**
 * M056 — relay-pair unit tests using injected fakes (no Electron,
 * no network, no real disk). Mirrors the M055 token-store test
 * harness.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  clearRelayToken,
  retireRelayToken,
  deriveDeviceGroupId,
  getOrCreatePhysicalDeviceSeed,
  getOrCreateInstallationId,
  loadRelayToken,
  pairRelay as pairRelayImpl,
  relayTokenRequiresPairingCutover,
  type RelayPairDeps,
  type RelayPairFsLike,
  type RelayPairSafeStorageLike,
} from "../../../electron/auth/relay-pair";

function makeFs(): RelayPairFsLike & {
  files: Map<string, Buffer>;
  modes: Map<string, number>;
  renames: Array<[string, string]>;
  mkdirs: Array<{ path: string; mode?: number }>;
  dirs: Set<string>;
} {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  const renames: Array<[string, string]> = [];
  const mkdirs: Array<{ path: string; mode?: number }> = [];
  const dirs = new Set<string>();
  return {
    files,
    modes,
    renames,
    mkdirs,
    dirs,
    mkdirSync: (p, options) => {
      if (dirs.has(p) && !options?.recursive) {
        const err = new Error(`EEXIST: ${p}`) as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      mkdirs.push({ path: p, mode: options?.mode });
      dirs.add(p);
    },
    rmdirSync: (p) => {
      if (!dirs.delete(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
    },
    linkSync: (from, to) => {
      if (files.has(to)) {
        const err = new Error(`EEXIST: ${to}`) as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      const buf = files.get(from);
      if (!buf) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.set(to, buf);
      const mode = modes.get(from);
      if (mode !== undefined) modes.set(to, mode);
    },
    writeFileSync: (p, data, options) => {
      const buf =
        typeof data === "string"
          ? Buffer.from(data, "utf-8")
          : Buffer.from(data);
      files.set(p, buf);
      if (options?.mode !== undefined) modes.set(p, options.mode);
    },
    readFileSync: (p) => {
      const f = files.get(p);
      if (!f) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return f;
    },
    renameSync: (from, to) => {
      const buf = files.get(from);
      if (!buf) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.set(to, buf);
      files.delete(from);
      const mode = modes.get(from);
      if (mode !== undefined) {
        modes.set(to, mode);
        modes.delete(from);
      }
      renames.push([from, to]);
    },
    unlinkSync: (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.delete(p);
      modes.delete(p);
    },
  };
}

const TEST_SERVER_FINGERPRINT = "server-identity-test";

function pairRelay(
  deps: RelayPairDeps,
  args: Omit<Parameters<typeof pairRelayImpl>[1], "trustedServerFingerprint"> & {
    trustedServerFingerprint?: string;
  },
): ReturnType<typeof pairRelayImpl> {
  return pairRelayImpl(deps, {
    ...args,
    trustedServerFingerprint: args.trustedServerFingerprint ?? TEST_SERVER_FINGERPRINT,
  });
}

function makeSafeStorage(available: boolean): RelayPairSafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) =>
      Buffer.concat([Buffer.from("ENC:"), Buffer.from(s, "utf-8")]),
    decryptString: (b) => {
      const tag = b.subarray(0, 4).toString("utf-8");
      if (tag !== "ENC:") throw new Error("decrypt failed");
      return b.subarray(4).toString("utf-8");
    },
  };
}

function makeDeps(opts: {
  encryptionAvailable: boolean;
  fetchImpl?: typeof fetch;
}): RelayPairDeps & { fs: ReturnType<typeof makeFs> } {
  const fs = makeFs();
  const defaultFetch: typeof fetch = (async () => {
    throw new Error("fetch not configured");
  }) as typeof fetch;
  return {
    fs,
    safeStorage: makeSafeStorage(opts.encryptionAvailable),
    userDataDir: "/user-data",
    fetchImpl: opts.fetchImpl ?? defaultFetch,
    hostname: () => "test-host",
  };
}

function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function relayFile(serverUrl: string): string {
  const scope = createHash("sha256")
    .update(normalizeServerUrl(serverUrl))
    .digest("hex")
    .slice(0, 32);
  return `/user-data/relay-token-${scope}.json`;
}

function fakeOk(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

describe("pairRelay (M056)", () => {
  test("posts to /api/relay/pair with bearer + hostname label, persists encrypted", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedBody = "";
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://server.test/api/relay/pair");
      observedHeaders = (init?.headers as Record<string, string>) ?? {};
      observedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ relayToken: "rty_abcdefg-hijklmnop-qrstuvwxyz" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const deps = makeDeps({ encryptionAvailable: true, fetchImpl });
    const token = await pairRelay(deps, {
      serverUrl: "https://server.test",
      accessToken: "AT-1",
    });
    expect(token).toBe("rty_abcdefg-hijklmnop-qrstuvwxyz");
    expect(observedHeaders["Authorization"]).toBe("Bearer AT-1");
    expect(observedHeaders["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(observedBody) as {
      deviceLabel: string;
      capabilities: { profile: string };
    };
    expect(parsed.deviceLabel).toBe("test-host");
    expect(parsed.capabilities.profile).toBe("desktop-agent");

    const relayFilePath = relayFile("https://server.test");
    // Atomic write — body landed at the scoped final path via tmp + rename.
    expect(deps.fs.renames.some(([, to]) => to === relayFilePath)).toBe(true);
    expect([...deps.fs.files.keys()].some((p) => p.startsWith(`${relayFilePath}.`))).toBe(
      false,
    );
    expect(deps.fs.modes.get(relayFilePath)).toBe(0o600);

    // Encrypted header tag.
    const persisted = deps.fs.files.get(relayFilePath)!;
    const newlineIdx = persisted.indexOf(0x0a);
    const header = persisted.subarray(0, newlineIdx).toString("utf-8");
    expect(header).toBe("nautilo-relay-v1-enc");
  });

  test("plaintext header when safeStorage unavailable", async () => {
    const deps = makeDeps({
      encryptionAvailable: false,
      fetchImpl: fakeOk({ relayToken: "rty_test-token-abcdef" }),
    });
    await pairRelay(deps, {
      serverUrl: "https://s",
      accessToken: "AT",
    });
    const persisted = deps.fs.files.get(relayFile("https://s"))!;
    const newlineIdx = persisted.indexOf(0x0a);
    expect(persisted.subarray(0, newlineIdx).toString("utf-8")).toBe(
      "nautilo-relay-v1-pt",
    );
  });

  test("throws and does NOT write on non-2xx", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    const deps = makeDeps({ encryptionAvailable: true, fetchImpl });
    await expect(
      pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" }),
    ).rejects.toThrow(/401/);
    expect(deps.fs.files.has(relayFile("https://s"))).toBe(false);
  });

  test("throws when relayToken missing or wrong format", async () => {
    const deps = makeDeps({
      encryptionAvailable: true,
      fetchImpl: fakeOk({ relayToken: "wrong-prefix" }),
    });
    await expect(
      pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" }),
    ).rejects.toThrow(/relayToken/);
    expect(deps.fs.files.has(relayFile("https://s"))).toBe(false);
  });

  test("scopes persisted relay tokens by server URL", async () => {
    const deps = makeDeps({
      encryptionAvailable: false,
      fetchImpl: fakeOk({ relayToken: "rty_scoped-token" }),
    });
    await pairRelay(deps, {
      serverUrl: "https://one.test",
      accessToken: "AT",
    });

    expect(loadRelayToken(deps, { serverUrl: "https://one.test" })).toBe(
      "rty_scoped-token",
    );
    expect(loadRelayToken(deps, { serverUrl: "https://two.test" })).toBeNull();
  });

  test("normalizes server URL for pair endpoint and token scope", async () => {
    let observedUrl = "";
    const fetchImpl: typeof fetch = (async (input) => {
      observedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ relayToken: "rty_normalized-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const deps = makeDeps({ encryptionAvailable: false, fetchImpl });

    await pairRelay(deps, {
      serverUrl: "https://server.test///",
      accessToken: "AT",
    });

    expect(observedUrl).toBe("https://server.test/api/relay/pair");
    expect(loadRelayToken(deps, { serverUrl: "https://server.test" })).toBe(
      "rty_normalized-token",
    );
  });

  test("cleans up unique temp file when persistence fails", async () => {
    const deps = makeDeps({
      encryptionAvailable: false,
      fetchImpl: fakeOk({ relayToken: "rty_cleanup-token" }),
    });
    deps.fs.renameSync = () => {
      throw new Error("rename failed");
    };

    await expect(
      pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" }),
    ).rejects.toThrow(/rename failed/);

    const relayFilePath = relayFile("https://s");
    expect(deps.fs.files.has(relayFilePath)).toBe(false);
    expect([...deps.fs.files.keys()].some((p) => p.startsWith(`${relayFilePath}.`))).toBe(
      false,
    );
  });
});

describe("loadRelayToken (M056)", () => {
  test("round-trips a pairRelay write under encryption", async () => {
    const deps = makeDeps({
      encryptionAvailable: true,
      fetchImpl: fakeOk({ relayToken: "rty_round-trip-token" }),
    });
    await pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" });
    expect(loadRelayToken(deps, { serverUrl: "https://s" })).toBe(
      "rty_round-trip-token",
    );
  });

  test("round-trips under plaintext fallback", async () => {
    const deps = makeDeps({
      encryptionAvailable: false,
      fetchImpl: fakeOk({ relayToken: "rty_plain-trip-token" }),
    });
    await pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" });
    expect(loadRelayToken(deps, { serverUrl: "https://s" })).toBe(
      "rty_plain-trip-token",
    );
  });

  test("returns null when file missing", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    expect(loadRelayToken(deps, { serverUrl: "https://s" })).toBeNull();
  });

  test("fails closed when disk says encrypted but platform can't decrypt", async () => {
    const writingDeps = makeDeps({
      encryptionAvailable: true,
      fetchImpl: fakeOk({ relayToken: "rty_x-y-z" }),
    });
    await pairRelay(writingDeps, {
      serverUrl: "https://s",
      accessToken: "AT",
    });
    // Same file, different deps where encryption is no longer available.
    const readDeps: RelayPairDeps = {
      ...makeDeps({ encryptionAvailable: false }),
      // Re-use the populated FS.
      fs: writingDeps.fs,
      userDataDir: "/user-data",
    };
    expect(loadRelayToken(readDeps, { serverUrl: "https://s" })).toBeNull();
  });

  test("rejects unknown header (corrupt/tampered)", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    deps.fs.writeFileSync(
      relayFile("https://s"),
      Buffer.from("nautilo-relay-v999-xx\n{}", "utf-8"),
    );
    expect(loadRelayToken(deps, { serverUrl: "https://s" })).toBeNull();
  });

  test("rejects payload missing rty_ prefix", async () => {
    const deps = makeDeps({ encryptionAvailable: false });
    deps.fs.writeFileSync(
      relayFile("https://s"),
      Buffer.from(
        "nautilo-relay-v1-pt\n" + JSON.stringify({ token: "no-prefix", pairedAt: 0 }),
        "utf-8",
      ),
    );
    expect(loadRelayToken(deps, { serverUrl: "https://s" })).toBeNull();
  });

  test("rejects payload whose embedded server URL does not match scope", () => {
    const deps = makeDeps({ encryptionAvailable: false });
    deps.fs.writeFileSync(
      relayFile("https://s"),
      Buffer.from(
        "nautilo-relay-v1-pt\n" +
          JSON.stringify({
            token: "rty_copied-from-another-server",
            pairedAt: 0,
            serverUrl: "https://other",
          }),
        "utf-8",
      ),
    );
    expect(loadRelayToken(deps, { serverUrl: "https://s" })).toBeNull();
  });
});

describe("clearRelayToken (M056)", () => {
  test("removes the file when present", async () => {
    const deps = makeDeps({
      encryptionAvailable: false,
      fetchImpl: fakeOk({ relayToken: "rty_clearme" }),
    });
    await pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" });
    expect(deps.fs.files.has(relayFile("https://s"))).toBe(true);
    clearRelayToken(deps, { serverUrl: "https://s" });
    expect(deps.fs.files.has(relayFile("https://s"))).toBe(false);
  });

  test("no-op when file already missing", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    expect(() => clearRelayToken(deps, { serverUrl: "https://s" })).not.toThrow();
  });
});

describe("retireRelayToken (D514)", () => {
  test("is exact-slot and treats only ENOENT as replay-safe", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    expect(() => retireRelayToken(deps, { serverUrl: "https://old" })).not.toThrow();
    const denied = new Error("denied") as NodeJS.ErrnoException;
    denied.code = "EACCES";
    deps.fs.unlinkSync = () => { throw denied; };
    expect(() => retireRelayToken(deps, { serverUrl: "https://old" })).toThrow("denied");
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_FILE = "/user-data/installation-id.json";

function capturePairBody(): {
  fetchImpl: typeof fetch;
  bodies: string[];
} {
  const bodies: string[] = [];
  const fetchImpl: typeof fetch = (async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ relayToken: "rty_pair-body-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

describe("installationId (D418)", () => {
  test("one physical workstation advertises one grouping identity across isolated tuple pairings", async () => {
    const fs = makeFs();
    const defaultCapture = capturePairBody();
    const namedCapture = capturePairBody();
    const physicalDeviceSeedPath = "/operator-state/physical-device-seed.json";
    const defaultTuple: RelayPairDeps = {
      ...makeDeps({ encryptionAvailable: true, fetchImpl: defaultCapture.fetchImpl }),
      fs,
      userDataDir: "/Application Support/Nautilo",
      physicalDeviceSeedPath,
      uuid: () => "aaaaaaaa-1111-4111-8111-111111111111",
    };
    const namedTuple: RelayPairDeps = {
      ...makeDeps({ encryptionAvailable: true, fetchImpl: namedCapture.fetchImpl }),
      fs,
      userDataDir: "/Application Support/Nautilo-stack-246-taylor",
      physicalDeviceSeedPath,
      uuid: () => "bbbbbbbb-2222-4222-8222-222222222222",
    };

    await pairRelay(defaultTuple, {
      serverUrl: "https://s",
      accessToken: "AT",
      trustedServerFingerprint: "canonical-server-a",
    });
    await pairRelay(namedTuple, {
      serverUrl: "https://alias-for-s.test",
      accessToken: "AT",
      trustedServerFingerprint: "canonical-server-a",
    });
    const defaultBody = JSON.parse(defaultCapture.bodies[0]!) as {
      installationId: string;
      deviceGroupId?: string;
    };
    const namedBody = JSON.parse(namedCapture.bodies[0]!) as {
      installationId: string;
      deviceGroupId?: string;
    };

    // Pairing credentials and generations remain tuple-isolated authority.
    expect(namedBody.installationId).not.toBe(defaultBody.installationId);
    // Settings groups those pairings under one non-authoritative physical
    // workstation identity shared outside the tuple-scoped userData roots.
    expect(UUID_RE.test(defaultBody.deviceGroupId ?? "")).toBe(true);
    expect(namedBody.deviceGroupId).toBe(defaultBody.deviceGroupId);
  });

  test("pairRelay includes a UUID installationId in the pair body", async () => {
    const { fetchImpl, bodies } = capturePairBody();
    const deps = makeDeps({ encryptionAvailable: false, fetchImpl });
    await pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" });
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]!) as {
      installationId: string;
      deviceLabel: string;
      capabilities: { profile: string };
    };
    expect(UUID_RE.test(parsed.installationId)).toBe(true);
    expect(parsed.deviceLabel).toBe("test-host");
    expect(parsed.capabilities.profile).toBe("desktop-agent");
  });

  test("installationId is stable across repeated pair requests (same file)", async () => {
    const { fetchImpl, bodies } = capturePairBody();
    const deps = makeDeps({ encryptionAvailable: false, fetchImpl });
    await pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" });
    await pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" });
    expect(bodies).toHaveLength(2);
    const first = (JSON.parse(bodies[0]!) as { installationId: string }).installationId;
    const second = (JSON.parse(bodies[1]!) as { installationId: string }).installationId;
    expect(UUID_RE.test(first)).toBe(true);
    expect(second).toBe(first);
    // One shared file, written once (first pair); second pair reuses it.
    expect(deps.fs.files.has(INSTALLATION_ID_FILE)).toBe(true);
    expect(deps.fs.modes.get(INSTALLATION_ID_FILE)).toBe(0o600);
    // Atomic write landed via tmp + rename.
    expect(deps.fs.renames.some(([, to]) => to === INSTALLATION_ID_FILE)).toBe(true);
    expect(
      [...deps.fs.files.keys()].some((p) => p.startsWith(`${INSTALLATION_ID_FILE}.`)),
    ).toBe(false);
  });

  test("installationId is NOT server-scoped — same ID across different servers", async () => {
    const { fetchImpl, bodies } = capturePairBody();
    const deps = makeDeps({ encryptionAvailable: false, fetchImpl });
    await pairRelay(deps, { serverUrl: "https://one.test", accessToken: "AT" });
    await pairRelay(deps, { serverUrl: "https://two.test", accessToken: "AT" });
    expect(bodies).toHaveLength(2);
    const a = (JSON.parse(bodies[0]!) as { installationId: string }).installationId;
    const b = (JSON.parse(bodies[1]!) as { installationId: string }).installationId;
    // Same installation ID shared across servers...
    expect(a).toBe(b);
    expect(UUID_RE.test(a)).toBe(true);
    // ...while relay tokens remain server-scoped (two distinct files).
    expect(relayFile("https://one.test")).not.toBe(relayFile("https://two.test"));
    expect(deps.fs.files.has(relayFile("https://one.test"))).toBe(true);
    expect(deps.fs.files.has(relayFile("https://two.test"))).toBe(true);
    // Single shared installation-id file, not per-server.
    expect(
      [...deps.fs.files.keys()].filter((p) => p === INSTALLATION_ID_FILE),
    ).toHaveLength(1);
  });

  test("clearRelayToken does NOT delete the installationId file", async () => {
    const { fetchImpl } = capturePairBody();
    const deps = makeDeps({ encryptionAvailable: false, fetchImpl });
    await pairRelay(deps, { serverUrl: "https://s", accessToken: "AT" });
    const idBefore = getOrCreateInstallationId(deps);
    expect(deps.fs.files.has(INSTALLATION_ID_FILE)).toBe(true);

    clearRelayToken(deps, { serverUrl: "https://s" });

    // Relay token gone, installation-id file untouched, ID unchanged.
    expect(deps.fs.files.has(relayFile("https://s"))).toBe(false);
    expect(deps.fs.files.has(INSTALLATION_ID_FILE)).toBe(true);
    expect(getOrCreateInstallationId(deps)).toBe(idBefore);
  });

  test("getOrCreateInstallationId creates the file with 0600 + atomic rename on first call", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    expect(deps.fs.files.has(INSTALLATION_ID_FILE)).toBe(false);
    const id = getOrCreateInstallationId(deps);
    expect(UUID_RE.test(id)).toBe(true);
    expect(deps.fs.files.has(INSTALLATION_ID_FILE)).toBe(true);
    expect(deps.fs.modes.get(INSTALLATION_ID_FILE)).toBe(0o600);
    expect(deps.fs.renames.some(([, to]) => to === INSTALLATION_ID_FILE)).toBe(true);
    expect(
      [...deps.fs.files.keys()].some((p) => p.startsWith(`${INSTALLATION_ID_FILE}.`)),
    ).toBe(false);
  });

  test("getOrCreateInstallationId reuses an existing valid UUID and does not rewrite", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    const existing = "11111111-2222-4333-8444-555555555555";
    deps.fs.writeFileSync(
      INSTALLATION_ID_FILE,
      Buffer.from(JSON.stringify({ installationId: existing, createdAt: 0 }), "utf-8"),
    );
    const before = deps.fs.renames.length;
    const id = getOrCreateInstallationId(deps);
    expect(id).toBe(existing);
    expect(deps.fs.renames.length).toBe(before); // no rewrite
  });

  test("getOrCreateInstallationId regenerates + overwrites when the file is corrupt", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    deps.fs.writeFileSync(INSTALLATION_ID_FILE, Buffer.from("not-json", "utf-8"));
    const id = getOrCreateInstallationId(deps);
    expect(UUID_RE.test(id)).toBe(true);
    // Overwrote the corrupt file with a fresh valid payload.
    const persisted = deps.fs.files.get(INSTALLATION_ID_FILE)!;
    const parsed = JSON.parse(persisted.toString("utf-8")) as { installationId: string };
    expect(parsed.installationId).toBe(id);
  });

  test("getOrCreateInstallationId regenerates when the stored value is not a UUID", () => {
    const deps = makeDeps({ encryptionAvailable: true });
    deps.fs.writeFileSync(
      INSTALLATION_ID_FILE,
      Buffer.from(
        JSON.stringify({ installationId: "not-a-uuid", createdAt: 0 }),
        "utf-8",
      ),
    );
    const id = getOrCreateInstallationId(deps);
    expect(UUID_RE.test(id)).toBe(true);
    expect(id).not.toBe("not-a-uuid");
  });

  test("uuid seam is honored for deterministic generation", () => {
    const fixed = "00000000-1111-4222-8333-444444444444";
    const deps = {
      ...makeDeps({ encryptionAvailable: true }),
      uuid: () => fixed,
    };
    expect(getOrCreateInstallationId(deps)).toBe(fixed);
    const persisted = deps.fs.files.get(INSTALLATION_ID_FILE)!;
    expect((JSON.parse(persisted.toString("utf-8")) as { installationId: string }).installationId).toBe(fixed);
  });
});

describe("deviceGroupId (D480)", () => {
  const SEED_PATH = "/operator-state/physical-device-seed.json";

  function seededDeps(seedByte = 7): RelayPairDeps & { fs: ReturnType<typeof makeFs> } {
    return {
      ...makeDeps({ encryptionAvailable: false }),
      physicalDeviceSeedPath: SEED_PATH,
      randomBytes: () => Buffer.alloc(32, seedByte),
    };
  }

  test("repairs corrupt Family-C state atomically with owner-only permissions", () => {
    const deps = seededDeps();
    deps.fs.writeFileSync(SEED_PATH, Buffer.from("corrupt", "utf-8"));

    const seed = getOrCreatePhysicalDeviceSeed(deps);

    expect(seed).toEqual(Buffer.alloc(32, 7));
    expect(deps.fs.modes.get(SEED_PATH)).toBe(0o600);
    expect(deps.fs.mkdirs).toContainEqual({ path: "/operator-state", mode: 0o700 });
    expect(
      JSON.parse(deps.fs.files.get(SEED_PATH)!.toString("utf-8")),
    ).toMatchObject({ v: 1, seed: Buffer.alloc(32, 7).toString("base64url") });
  });

  test("concurrent first writers converge on the published winner without replacement", () => {
    const first = seededDeps(1);
    const second: RelayPairDeps = {
      ...seededDeps(2),
      fs: first.fs,
    };
    const firstSeed = getOrCreatePhysicalDeviceSeed(first);
    const secondSeed = getOrCreatePhysicalDeviceSeed(second);

    expect(secondSeed).toEqual(firstSeed);
    expect(second.fs.files.get(SEED_PATH)).toEqual(first.fs.files.get(SEED_PATH));
  });

  test("uses the trusted fingerprint for alias stability and split-server unlinkability", () => {
    const deps = seededDeps(3);
    const aliasA = deriveDeviceGroupId(deps, "server-identity-a");
    const aliasB = deriveDeviceGroupId(deps, "server-identity-a");
    const distinctServer = deriveDeviceGroupId(deps, "server-identity-b");

    expect(aliasB).toBe(aliasA);
    expect(distinctServer).not.toBe(aliasA);
    expect(UUID_RE.test(aliasA)).toBe(true);
    expect(() => deriveDeviceGroupId(deps, "")).toThrow(/trusted server fingerprint/);
  });

  test("marks an acknowledged v2 rotation once, while interrupted attempts remain retryable", async () => {
    const deps = seededDeps(4);
    const legacyPayload = {
      token: "rty_precontract-token",
      pairedAt: 0,
      serverUrl: "https://s",
    };
    deps.fs.writeFileSync(
      relayFile("https://s"),
      Buffer.from(`nautilo-relay-v1-pt\n${JSON.stringify(legacyPayload)}`, "utf-8"),
    );
    expect(
      relayTokenRequiresPairingCutover(deps, {
        serverUrl: "https://s",
        trustedServerFingerprint: "server-a",
      }),
    ).toBe(true);

    const failed = {
      ...deps,
      fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch,
    };
    await expect(
      pairRelay(failed, {
        serverUrl: "https://s",
        accessToken: "AT",
        trustedServerFingerprint: "server-a",
      }),
    ).rejects.toThrow(/503/);
    expect(
      relayTokenRequiresPairingCutover(deps, {
        serverUrl: "https://s",
        trustedServerFingerprint: "server-a",
      }),
    ).toBe(true);

    const acknowledged = {
      ...deps,
      fetchImpl: fakeOk({
        relayToken: "rty_v2-token",
        pairingContractVersion: 2,
      }),
    };
    await pairRelay(acknowledged, {
      serverUrl: "https://s",
      accessToken: "AT",
      trustedServerFingerprint: "server-a",
    });
    // The restart path sees a v2 marker and reuses the cached token.
    expect(
      relayTokenRequiresPairingCutover(deps, {
        serverUrl: "https://s",
        trustedServerFingerprint: "server-a",
      }),
    ).toBe(false);
  });

  test("records an older-server response so it cannot cause token churn", async () => {
    const deps = seededDeps(5);
    await pairRelay(
      {
        ...deps,
        fetchImpl: fakeOk({ relayToken: "rty_legacy-server-token" }),
      },
      {
        serverUrl: "https://s",
        accessToken: "AT",
        trustedServerFingerprint: "server-a",
      },
    );

    expect(
      relayTokenRequiresPairingCutover(deps, {
        serverUrl: "https://s",
        trustedServerFingerprint: "server-a",
      }),
    ).toBe(false);
    expect(
      relayTokenRequiresPairingCutover(deps, {
        serverUrl: "https://s",
        trustedServerFingerprint: "server-b",
      }),
    ).toBe(true);
  });
});
