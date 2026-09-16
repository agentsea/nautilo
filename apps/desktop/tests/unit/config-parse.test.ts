/**
 * Unit tests for config.parseConfig (D057 2a.2).
 *
 * parseConfig is the defensive gate between stored-on-disk JSON and our
 * runtime DesktopConfig. Anything it doesn't recognize returns null,
 * which triggers the first-run picker. We explicitly test each failure
 * shape so a future schema bump doesn't silently accept malformed data.
 *
 * Doesn't touch the filesystem — those paths go through Electron's
 * app.getPath which we don't have in a bun:test context.
 */

import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearDesktopConfigFile,
  configForActiveConnection,
  configForLegacyActiveConnection,
  configForVerifiedLegacyActiveConnection,
  parseConfig,
  projectActiveAuthority,
  withCodexConnectionIntent,
  withHermesConnectionIntent,
  writeDesktopConfigAtomically,
  type DesktopConfigWriteFs,
} from "../../electron/config-schema";

let tempRoot = "";

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-config-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("parseConfig — valid shapes", () => {
  test("connect mode with serverUrl", () => {
    expect(parseConfig({ version: 1, mode: "connect", serverUrl: "https://x" })).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "https://x",
    });
  });

  test("preserves the optional Codex connection intent", () => {
    expect(parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://x",
      codexConnectionEnabled: true,
    })).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "https://x",
      codexConnectionEnabled: true,
    });
  });

  test("preserves the optional Hermes connection intent", () => {
    expect(parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://x",
      hermesConnectionEnabled: true,
    })).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "https://x",
      hermesConnectionEnabled: true,
    });
  });

  test("parses a complete D514 active-authority marker and projects its exact pairing", () => {
    const config = parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://alpha.example.test",
      activeAuthority: {
        canonicalOrigin: "https://alpha.example.test",
        revision: "revision-17",
        connectionAttemptId: "attempt-17",
        serverFingerprint: "fingerprint-17",
      },
    });
    expect(config).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "https://alpha.example.test",
      activeAuthority: {
        canonicalOrigin: "https://alpha.example.test",
        revision: "revision-17",
        connectionAttemptId: "attempt-17",
        serverFingerprint: "fingerprint-17",
      },
    });
    expect(config && projectActiveAuthority(config)).toEqual({
      scope: "https://alpha.example.test",
      revision: "revision-17",
      connectionAttemptId: "attempt-17",
      serverFingerprint: "fingerprint-17",
    });
  });

  test("keeps a legacy config readable but marker-unavailable", () => {
    const config = parseConfig({ version: 1, mode: "connect", serverUrl: "https://alpha.example.test" });
    expect(config).not.toBeNull();
    expect(config && projectActiveAuthority(config)).toBeNull();
  });

  test("downgrades the unreleased branch-only marker without fingerprint to legacy truth", () => {
    const config = parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://alpha.example.test",
      activeAuthority: {
        canonicalOrigin: "https://alpha.example.test",
        revision: "branch-revision",
        connectionAttemptId: "branch-attempt",
      },
    });
    expect(config).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "https://alpha.example.test",
    });
    expect(config && projectActiveAuthority(config)).toBeNull();
  });

  test("ignores malformed Codex connection intent without rejecting config", () => {
    expect(parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://x",
      codexConnectionEnabled: "yes",
    })).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "https://x",
    });
  });
});

describe("configForVerifiedLegacyActiveConnection", () => {
  const guarded = {
    version: 1 as const,
    mode: "connect" as const,
    serverUrl: "http://127.0.0.1:13601",
    activeAuthority: {
      canonicalOrigin: "http://127.0.0.1:13601",
      revision: "legacy-revision",
      connectionAttemptId: "legacy-attempt",
      serverFingerprint: null,
    },
    codexConnectionEnabled: true,
  };

  test("completes only the exact legacy guard and preserves adjacent intent", () => {
    const completed = configForVerifiedLegacyActiveConnection(guarded, {
      serverUrl: "http://127.0.0.1:13601/path",
      serverFingerprint: "desktop-app|http://127.0.0.1:13601",
    });
    expect(projectActiveAuthority(completed)).toEqual({
      scope: "http://127.0.0.1:13601",
      revision: "legacy-revision",
      connectionAttemptId: "legacy-attempt",
      serverFingerprint: "desktop-app|http://127.0.0.1:13601",
    });
    expect(completed.codexConnectionEnabled).toBe(true);
  });

  test("rejects foreign origins, complete authorities, and invalid fingerprints", () => {
    expect(() => configForVerifiedLegacyActiveConnection(guarded, {
      serverUrl: "http://127.0.0.1:13602",
      serverFingerprint: "fingerprint-a",
    })).toThrow("does not match");
    expect(() => configForVerifiedLegacyActiveConnection({
      ...guarded,
      activeAuthority: { ...guarded.activeAuthority, serverFingerprint: "fingerprint-a" },
    }, {
      serverUrl: guarded.serverUrl,
      serverFingerprint: "fingerprint-a",
    })).toThrow("does not match");
    expect(() => configForVerifiedLegacyActiveConnection(guarded, {
      serverUrl: guarded.serverUrl,
      serverFingerprint: "",
    })).toThrow("fingerprint is invalid");
  });
});

describe("withCodexConnectionIntent", () => {
  test("updates only Codex intent on an existing desktop config", () => {
    expect(withCodexConnectionIntent({
      version: 1,
      mode: "connect",
      serverUrl: "https://existing",
    }, "https://active", true)).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "https://existing",
      codexConnectionEnabled: true,
    });
  });

  test("preserves the active pairing marker while changing Codex intent", () => {
    const current = configForActiveConnection(null, {
      serverUrl: "https://alpha.example.test",
      connectionAttemptId: "attempt-17",
      serverFingerprint: "fingerprint-17",
    }, { mintRevision: () => "revision-17" });
    expect(withCodexConnectionIntent(current, "https://ignored.example", false)).toEqual({
      ...current,
      codexConnectionEnabled: false,
    });
  });

  test("creates the normal connect config for a dev profile without one", () => {
    expect(withCodexConnectionIntent(null, "http://127.0.0.1:3010", false)).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "http://127.0.0.1:3010",
      codexConnectionEnabled: false,
    });
  });
});

describe("withHermesConnectionIntent", () => {
  test("updates only Hermes intent and preserves adjacent connection state", () => {
    const current = configForActiveConnection(null, {
      serverUrl: "https://alpha.example.test",
      connectionAttemptId: "attempt-hermes",
      serverFingerprint: "fingerprint-hermes",
    }, { mintRevision: () => "revision-hermes" });
    expect(withHermesConnectionIntent({ ...current, codexConnectionEnabled: true }, "https://ignored", true))
      .toEqual({ ...current, codexConnectionEnabled: true, hermesConnectionEnabled: true });
  });
});

describe("configForActiveConnection", () => {
  test("mints a fresh revision for a new attempt but resumes the same durable attempt idempotently", () => {
    const first = configForActiveConnection(null, {
      serverUrl: "https://alpha.example.test/base",
      connectionAttemptId: "attempt-1",
      serverFingerprint: "fingerprint-1",
    }, { mintRevision: () => "revision-1" });
    let mintCalls = 0;
    const resumed = configForActiveConnection(first, {
      serverUrl: "https://alpha.example.test/other-routing-path",
      connectionAttemptId: "attempt-1",
      serverFingerprint: "fingerprint-1",
    }, { mintRevision: () => {
      mintCalls += 1;
      return "must-not-be-used";
    } });
    expect(resumed).toBe(first);
    expect(mintCalls).toBe(0);
    expect(() => configForActiveConnection(first, {
      serverUrl: "https://alpha.example.test/base",
      connectionAttemptId: "attempt-2",
      serverFingerprint: "fingerprint-2",
    }, { mintRevision: () => "revision-1" })).toThrow("fresh bounded opaque marker");
    let crossOriginMintCalls = 0;
    expect(() => configForActiveConnection(first, {
      serverUrl: "https://other.nautilo.dev/base",
      connectionAttemptId: "attempt-1",
      serverFingerprint: "fingerprint-1",
    }, { mintRevision: () => {
      crossOriginMintCalls += 1;
      return "must-not-be-used";
    } })).toThrow("already bound to a different origin");
    expect(crossOriginMintCalls).toBe(0);
    expect(() => configForActiveConnection(first, {
      serverUrl: "https://alpha.example.test/base",
      connectionAttemptId: "attempt-1",
      serverFingerprint: "different-fingerprint",
    }, { mintRevision: () => "must-not-be-used" })).toThrow("different fingerprint");
  });
});

describe("configForLegacyActiveConnection", () => {
  test("mints an opaque offline guard without claiming a server fingerprint", () => {
    const legacy = configForLegacyActiveConnection({
      version: 1,
      mode: "connect",
      serverUrl: "https://offline.nautilo.dev/routing-base",
      codexConnectionEnabled: true,
    }, {
      connectionAttemptId: "legacy-offline-a",
    }, { mintRevision: () => "legacy-revision-a" });
    expect(projectActiveAuthority(legacy)).toEqual({
      scope: "https://offline.nautilo.dev",
      revision: "legacy-revision-a",
      connectionAttemptId: "legacy-offline-a",
      serverFingerprint: null,
    });
    expect(legacy.serverUrl).toBe("https://offline.nautilo.dev/routing-base");
    expect(legacy.codexConnectionEnabled).toBe(true);
  });

  test("does not let a normal connection commit omit its verified fingerprint", () => {
    expect(() => configForActiveConnection(null, {
      serverUrl: "https://alpha.example.test",
      connectionAttemptId: "attempt-real",
      serverFingerprint: null as unknown as string,
    }, { mintRevision: () => "revision-real" })).toThrow("fingerprint");
  });
});

describe("parseConfig — rejections", () => {
  test("null / undefined / primitive", () => {
    expect(parseConfig(null)).toBeNull();
    expect(parseConfig(undefined)).toBeNull();
    expect(parseConfig("string")).toBeNull();
    expect(parseConfig(42)).toBeNull();
  });

  test("wrong version", () => {
    expect(parseConfig({ version: 0, mode: "local" })).toBeNull();
    expect(parseConfig({ version: 2, mode: "local" })).toBeNull();
    expect(parseConfig({ version: "1", mode: "local" })).toBeNull();
    expect(parseConfig({ mode: "local" })).toBeNull(); // missing
  });

  test("unknown mode", () => {
    expect(parseConfig({ version: 1, mode: "local" })).toBeNull();
    expect(parseConfig({ version: 1, mode: "cloud" })).toBeNull();
    expect(parseConfig({ version: 1, mode: "other" })).toBeNull();
    expect(parseConfig({ version: 1 })).toBeNull();
    expect(parseConfig({ version: 1, mode: null })).toBeNull();
  });

  test("connect mode without serverUrl", () => {
    expect(parseConfig({ version: 1, mode: "connect" })).toBeNull();
    expect(parseConfig({ version: 1, mode: "connect", serverUrl: "" })).toBeNull();
    expect(parseConfig({ version: 1, mode: "connect", serverUrl: 42 })).toBeNull();
  });

  test("rejects malformed or partial active-authority markers instead of treating them as legacy", () => {
    expect(parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://alpha.example.test",
      activeAuthority: { canonicalOrigin: "https://alpha.example.test", revision: "revision-17" },
    })).toBeNull();
    expect(parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://alpha.example.test",
      activeAuthority: {
        canonicalOrigin: "https://alpha.example.test",
        revision: "revision-17",
        connectionAttemptId: "attempt-17",
        serverFingerprint: null,
      },
    })).toBeNull();
    expect(parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://alpha.example.test",
      activeAuthority: {
        canonicalOrigin: "https://alpha.example.test",
        revision: "revision-17",
        connectionAttemptId: "attempt-17",
        serverFingerprint: "fingerprint-17",
        extra: true,
      },
    })).toBeNull();
    expect(parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://alpha.example.test/base",
      activeAuthority: {
        canonicalOrigin: "https://wrong-origin.example",
        revision: "revision-17",
        connectionAttemptId: "attempt-17",
        serverFingerprint: "fingerprint-17",
      },
    })).toBeNull();
  });

  test("keeps scoped server routing while authority scope stays the canonical origin", () => {
    const config = configForActiveConnection(null, {
      serverUrl: "https://alpha.example.test/base/workbench",
      connectionAttemptId: "attempt-scoped",
      serverFingerprint: "desktop-app|https://api.nautilo.dev",
    }, { mintRevision: () => "revision-scoped" });
    expect(config.serverUrl).toBe("https://alpha.example.test/base/workbench");
    expect(projectActiveAuthority(config)).toEqual({
      scope: "https://alpha.example.test",
      revision: "revision-scoped",
      connectionAttemptId: "attempt-scoped",
      serverFingerprint: "desktop-app|https://api.nautilo.dev",
    });
  });

  test("ignores extra fields on connect", () => {
    // Extra fields don't kill the parse — forward compatibility for
    // minor schema extensions. Only MODE + VERSION + required fields
    // are strictly validated.
    expect(parseConfig({
      version: 1,
      mode: "connect",
      serverUrl: "https://x",
      hobby: "gardening",
    })).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "https://x",
    });
  });
});

describe("clearDesktopConfig", () => {
  test("removes only the persisted config and tolerates a missing file", () => {
    const configPath = path.join(tempRoot, "config.json");
    const unrelatedPath = path.join(tempRoot, "installation-id");
    fs.writeFileSync(configPath, "{}");
    fs.writeFileSync(unrelatedPath, "installation-id");

    clearDesktopConfigFile(configPath, { unlinkSync: fs.unlinkSync });
    clearDesktopConfigFile(configPath, { unlinkSync: fs.unlinkSync });

    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.readFileSync(unrelatedPath, "utf8")).toBe("installation-id");
  });
});

describe("writeDesktopConfigAtomically", () => {
  function memoryFs(
    files: Map<string, string>,
    options: Readonly<{ failRename?: boolean; failWriteAfterCreate?: boolean }> = {},
  ): DesktopConfigWriteFs {
    const descriptors = new Map<number, string>();
    let nextDescriptor = 1;
    return {
      mkdirSync: () => {},
      openSync: (filePath, flags, mode) => {
        expect(flags).toBe("wx");
        expect(mode).toBe(0o600);
        if (files.has(filePath)) throw new Error("EEXIST");
        files.set(filePath, "");
        const descriptor = nextDescriptor;
        nextDescriptor += 1;
        descriptors.set(descriptor, filePath);
        return descriptor;
      },
      writeFileSync: (descriptor, data, writeOptions) => {
        expect(writeOptions).toEqual({ encoding: "utf-8" });
        const filePath = descriptors.get(descriptor);
        if (!filePath) throw new Error("unknown descriptor");
        files.set(filePath, data);
        if (options.failWriteAfterCreate) throw new Error("write failed after create");
      },
      closeSync: (descriptor) => {
        if (!descriptors.delete(descriptor)) throw new Error("unknown descriptor");
      },
      renameSync: (from, to) => {
        if (options.failRename) throw new Error("rename failed");
        const contents = files.get(from);
        if (contents === undefined) throw new Error("missing temporary config");
        files.set(to, contents);
        files.delete(from);
      },
      unlinkSync: (filePath) => { files.delete(filePath); },
    };
  }

  test("leaves the old config byte-for-byte intact when rename fails", () => {
    const target = "/profile/config.json";
    const oldContents = '{\n  "version": 1,\n  "mode": "connect",\n  "serverUrl": "https://old.example"\n}\n';
    const files = new Map([[target, oldContents]]);
    expect(() => writeDesktopConfigAtomically({
      filePath: target,
      directoryPath: "/profile",
      temporaryId: "writer-1",
      config: configForActiveConnection(null, {
        serverUrl: "https://new.example",
        connectionAttemptId: "attempt-2",
        serverFingerprint: "fingerprint-2",
      }, { mintRevision: () => "revision-2" }),
      fs: memoryFs(files, { failRename: true }),
    })).toThrow("rename failed");
    expect(files.get(target)).toBe(oldContents);
    expect(files.has(`${target}.writer-1.tmp`)).toBe(false);
  });

  test("makes new URL, revision, and attempt visible together only after rename", () => {
    const target = "/profile/config.json";
    const files = new Map<string, string>();
    const config = configForActiveConnection(null, {
      serverUrl: "https://alpha.example.test",
      connectionAttemptId: "attempt-18",
      serverFingerprint: "fingerprint-18",
    }, { mintRevision: () => "revision-18" });
    writeDesktopConfigAtomically({
      filePath: target,
      directoryPath: "/profile",
      temporaryId: "writer-2",
      config,
      fs: memoryFs(files),
    });
    expect(JSON.parse(files.get(target) ?? "")).toEqual({
      version: 1,
      mode: "connect",
      serverUrl: "https://alpha.example.test",
      activeAuthority: {
        canonicalOrigin: "https://alpha.example.test",
        revision: "revision-18",
        connectionAttemptId: "attempt-18",
        serverFingerprint: "fingerprint-18",
      },
    });
    expect(files.has(`${target}.writer-2.tmp`)).toBe(false);
  });

  test("cleans up the writer-owned temporary file after a partial write failure", () => {
    const target = "/profile/config.json";
    const files = new Map<string, string>();
    expect(() => writeDesktopConfigAtomically({
      filePath: target,
      directoryPath: "/profile",
      temporaryId: "writer-write-failure",
      config: configForActiveConnection(null, {
        serverUrl: "https://alpha.example.test",
        connectionAttemptId: "attempt-write-failure",
        serverFingerprint: "fingerprint-write-failure",
      }, { mintRevision: () => "revision-write-failure" }),
      fs: memoryFs(files, { failWriteAfterCreate: true }),
    })).toThrow("write failed after create");
    expect(files.has(`${target}.writer-write-failure.tmp`)).toBe(false);
    expect(files.has(target)).toBe(false);
  });

  test("does not unlink a competing writer temporary path when exclusive open reports EEXIST", () => {
    const target = "/profile/config.json";
    const temporaryPath = `${target}.writer-race.tmp`;
    const files = new Map([[temporaryPath, "owned by another writer"]]);
    expect(() => writeDesktopConfigAtomically({
      filePath: target,
      directoryPath: "/profile",
      temporaryId: "writer-race",
      config: configForActiveConnection(null, {
        serverUrl: "https://alpha.example.test",
        connectionAttemptId: "attempt-race",
        serverFingerprint: "fingerprint-race",
      }, { mintRevision: () => "revision-race" }),
      fs: memoryFs(files),
    })).toThrow("EEXIST");
    expect(files.get(temporaryPath)).toBe("owned by another writer");
  });

  test("rejects own-property null or false authority markers before creating a temporary file", () => {
    const target = "/profile/config.json";
    for (const malformedMarker of [null, false]) {
      const files = new Map<string, string>();
      expect(() => writeDesktopConfigAtomically({
        filePath: target,
        directoryPath: "/profile",
        temporaryId: `writer-invalid-marker-${String(malformedMarker)}`,
        config: {
          version: 1,
          mode: "connect",
          serverUrl: "https://alpha.example.test",
          activeAuthority: malformedMarker,
        } as unknown as Parameters<typeof writeDesktopConfigAtomically>[0]["config"],
        fs: memoryFs(files),
      })).toThrow("active authority marker");
      expect(files.size).toBe(0);
    }
  });
});
