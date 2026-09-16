/**
 * D423 Phase 4 — generic focused-resource substrate unit tests.
 *
 * Pins the wire contract for the discriminated `ChatFocusedResourceRef` union,
 * the kind-keyed resolver registry, and the unified `resolveFocusedResources`
 * orchestrator: shape/bounds, control-char rejection, kind-specific dedupe,
 * the 10-ref cap, the legacy artifact + D271 attachment adapters, and the
 * fail-closed posture for local-file refs (relay identity validation lands in
 * Phase 4.1.3). Verifies that private locators never leak into the manifest's
 * public display fields and that adding a future kind requires only a resolver
 * — not another composer pipeline.
 */
import { describe, expect, mock, test } from "bun:test";
import * as nodePath from "node:path";
import * as actualDb from "@nautilo/db";

const findArtifactByIdForNamespacesMock = mock(
  async ({
    artifactId,
    readableNamespaceIds,
  }: {
    artifactId: string;
    readableNamespaceIds: string[];
  }) => {
    if (
      artifactId === "reports/q3.xlsx" &&
      readableNamespaceIds.includes("namespace-readable")
    ) {
      return {
        artifactId,
        path: "authoritative/reports/q3.xlsx",
        mimeType: "application/vnd.ms-excel",
        size: 4096,
      };
    }
    return null;
  },
);

mock.module("@nautilo/db", () => ({
  ...actualDb,
  findArtifactByIdForNamespaces: findArtifactByIdForNamespacesMock,
}));

const {
  parseChatFocusedResourceRefs,
  resolveFocusedResources,
  focusedResourceDedupeKey,
  resolvedFocusedResourceDedupeKey,
  MAX_FOCUSED_RESOURCES,
  createDefaultFocusResolverRegistry,
  FocusResolverRegistry,
} = await import("../../src/messaging/focused-resources");
import type {
  FocusedResourceRelayRegistry,
  FocusedResourceRelaySnapshot,
} from "../../src/messaging/focused-resources";
const { adaptResolvedArtifactRefs } = await import("../../src/messaging/artifact-refs");
const { adaptNormalizedAttachments } = await import("../../src/messaging/attachments");

/**
 * D423 4.1.3 — mock relay registry for local-file resolver tests. Returns a
 * fixed snapshot (or `null` for "not connected") for a given (relayId, actor)
 * pair, exercising each fail-closed branch without touching byte transport.
 */
function makeMockRegistry(
  snapshots: Array<{
    relayId: string;
    actorId: string;
    snapshot: FocusedResourceRelaySnapshot | null;
  }>,
): FocusedResourceRelayRegistry {
  return {
    snapshotForFocusedResource(relayId: string, actorId: string) {
      const hit = snapshots.find(
        (s) => s.relayId === relayId && s.actorId === actorId,
      );
      return hit ? hit.snapshot : null;
    },
  };
}

const V4_DESKTOP_SNAPSHOT: FocusedResourceRelaySnapshot = {
  ownedByActor: true,
  protocolVersion: 4,
  profile: "desktop-agent",
  localFileExecution: true,
  allowedRoots: ["/Users/alice/demo"],
  canRunOffice: true,
};

describe("parseChatFocusedResourceRefs", () => {
  test("empty / null → []", () => {
    expect(parseChatFocusedResourceRefs(undefined)).toEqual([]);
    expect(parseChatFocusedResourceRefs(null)).toEqual([]);
  });

  test("parses a workspace-artifact ref (artifactId may contain '/')", () => {
    expect(parseChatFocusedResourceRefs([{ kind: "workspace-artifact", artifactId: "a/b" }]))
      .toEqual([{ kind: "workspace-artifact", artifactId: "a/b" }]);
  });

  test("parses a well-formed local-file ref", () => {
    const out = parseChatFocusedResourceRefs([
      {
        kind: "local-file",
        path: "/tmp/deck.pptx",
        rootPath: "/tmp",
        name: "deck.pptx",
        relayId: "relay-1",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("local-file");
  });

  test("non-array throws", () => {
    expect(() => parseChatFocusedResourceRefs({ kind: "workspace-artifact" })).toThrow();
  });

  test("over-cap throws (MAX_FOCUSED_RESOURCES)", () => {
    const many = Array.from({ length: MAX_FOCUSED_RESOURCES + 1 }, (_, i) => ({
      kind: "workspace-artifact" as const,
      artifactId: `a${i}`,
    }));
    expect(() => parseChatFocusedResourceRefs(many)).toThrow();
  });

  test("empty / control-char / oversized artifactId throws", () => {
    expect(() =>
      parseChatFocusedResourceRefs([{ kind: "workspace-artifact", artifactId: "" }]),
    ).toThrow();
    expect(() =>
      parseChatFocusedResourceRefs([{ kind: "workspace-artifact", artifactId: "bad\u0000id" }]),
    ).toThrow();
  });

  test("local-file rejects non-absolute path, separator in name, missing relayId", () => {
    expect(() =>
      parseChatFocusedResourceRefs([
        { kind: "local-file", path: "rel/path", rootPath: "/tmp", name: "x", relayId: "r" },
      ]),
    ).toThrow();
    expect(() =>
      parseChatFocusedResourceRefs([
        { kind: "local-file", path: "/tmp/a", rootPath: "/tmp", name: "a/b", relayId: "r" },
      ]),
    ).toThrow();
    expect(() =>
      parseChatFocusedResourceRefs([
        { kind: "local-file", path: "/tmp/a", rootPath: "/tmp", name: "a", relayId: "" },
      ]),
    ).toThrow();
  });

  test("unsupported kind throws", () => {
    expect(() =>
      parseChatFocusedResourceRefs([{ kind: "galaxy", artifactId: "x" } as unknown]),
    ).toThrow();
  });
});

describe("dedupe keys", () => {
  test("workspace-artifact dedupe key is kind:artifactId", () => {
    expect(focusedResourceDedupeKey({ kind: "workspace-artifact", artifactId: "x/1" })).toBe(
      "workspace-artifact:x/1",
    );
  });

  test("local-file dedupe key is kind:relayId:path", () => {
    expect(
      focusedResourceDedupeKey({
        kind: "local-file",
        path: "/tmp/a",
        rootPath: "/tmp",
        name: "a",
        relayId: "r1",
      }),
    ).toBe("local-file:r1:/tmp/a");
  });

  test("resolved manifest dedupe key mirrors the wire key per kind", () => {
    expect(
      resolvedFocusedResourceDedupeKey({
        kind: "workspace-artifact",
        displayName: "q3.xlsx",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read"],
        locator: { artifactId: "reports/q3.xlsx" },
      }),
    ).toBe("workspace-artifact:reports/q3.xlsx");
    expect(
      resolvedFocusedResourceDedupeKey({
        kind: "message-attachment",
        displayName: "pic.png",
        location: "server",
        lifetime: "message",
        capabilities: ["read"],
        locator: { attachmentId: "att-1" },
      }),
    ).toBe("message-attachment:att-1");
  });
});

describe("adaptResolvedArtifactRefs", () => {
  test("maps DB-resolved artifact refs to workspace-artifact manifest entries", () => {
    const out = adaptResolvedArtifactRefs([
      {
        artifactId: "reports/q3.xlsx",
        path: "authoritative/reports/q3.xlsx",
        mimeType: "application/vnd.ms-excel",
        size: 4096,
      },
    ]);
    expect(out).toHaveLength(1);
    const entry = out[0]!;
    expect(entry.kind).toBe("workspace-artifact");
    expect(entry.displayName).toBe("q3.xlsx");
    expect(entry.mimeType).toBe("application/vnd.ms-excel");
    expect(entry.size).toBe(4096);
    expect(entry.location).toBe("server");
    expect(entry.lifetime).toBe("workspace");
    expect(entry.capabilities).toEqual(["read"]);
    expect(entry.toolTarget).toEqual({
      tool: "file",
      zone: "workspace",
      path: "authoritative/reports/q3.xlsx",
    });
    // Private locator carries the artifactId but never reaches prompt prose.
    expect(entry.locator).toEqual({ artifactId: "reports/q3.xlsx" });
  });

  test("empty refs → []", () => {
    expect(adaptResolvedArtifactRefs([])).toEqual([]);
  });
});

describe("adaptNormalizedAttachments", () => {
  test("adapts only accepted attachments; rejects/stubs are dropped", () => {
    const out = adaptNormalizedAttachments([
      { id: "att-img", filename: "pic.png", decision: "accept", kind: "image" },
      { id: "att-aud", filename: "clip.m4a", decision: "accept", kind: "audio" },
      { id: "att-txt", filename: "notes.txt", decision: "accept", kind: "text" },
      { id: "att-rej", filename: "bad.exe", decision: "reject", code: "x", reason: "r" },
      { id: "att-stub", filename: "weird.bin", decision: "stub", kind: "document", reason: "r" },
    ]);
    expect(out.map((r) => r.kind)).toEqual([
      "message-attachment",
      "message-attachment",
      "message-attachment",
    ]);
    const caps = Object.fromEntries(out.map((r) => [r.displayName, r.capabilities]));
    expect(caps["pic.png"]).toEqual(["read"]);
    expect(caps["clip.m4a"]).toEqual(["transcribe"]);
    expect(caps["notes.txt"]).toEqual(["read"]);
    for (const entry of out) {
      expect(entry.lifetime).toBe("message");
      expect(entry.location).toBe("server");
      expect(entry.toolTarget).toBeUndefined();
    }
  });

  test("empty statuses → []", () => {
    expect(adaptNormalizedAttachments([])).toEqual([]);
  });
});

describe("resolveFocusedResources", () => {
  test("local-file refs fail closed: no manifest entry, no read, no upload", async () => {
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [
        {
          kind: "local-file",
          path: "/System/Volumes/Data/Data/tmp/deck.pptx",
          rootPath: "/System/Volumes/Data/Data/tmp",
          name: "deck.pptx",
          relayId: "relay-1",
        },
      ],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: ["namespace-readable"],
    });
    expect(manifest).toEqual([]);
  });

  test("workspace-artifact focus ref resolves via DB-authoritative lookup", async () => {
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [{ kind: "workspace-artifact", artifactId: "reports/q3.xlsx" }],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: ["namespace-readable"],
    });
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.kind).toBe("workspace-artifact");
    expect(manifest[0]?.displayName).toBe("q3.xlsx");
    expect(manifest[0]?.mimeType).toBe("application/vnd.ms-excel");
    expect(manifest[0]?.size).toBe(4096);
  });

  test("unauthorized workspace-artifact ref is dropped (advisory, never throws)", async () => {
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [{ kind: "workspace-artifact", artifactId: "nope/missing" }],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: ["namespace-readable"],
    });
    expect(manifest).toEqual([]);
  });

  test("one turn carries artifact + attachment + local-file; manifest is coherent and deduped", async () => {
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [
        { kind: "workspace-artifact", artifactId: "reports/q3.xlsx" },
        {
          kind: "local-file",
          path: "/tmp/deck.pptx",
          rootPath: "/tmp",
          name: "deck.pptx",
          relayId: "r1",
        },
      ],
      resolvedArtifactRefs: [
        // Legacy lane — SAME artifact as the focusedResourceRef above; must
        // collapse to one entry (kind-specific dedupe).
        {
          artifactId: "reports/q3.xlsx",
          path: "authoritative/reports/q3.xlsx",
          mimeType: "application/vnd.ms-excel",
          size: 4096,
        },
      ],
      attachmentStatuses: [
        { id: "att-1", filename: "pic.png", decision: "accept", kind: "image" },
      ],
      readableNamespaceIds: ["namespace-readable"],
    });
    // One workspace-artifact (deduped), one message-attachment, zero local-file.
    const kinds = manifest.map((r) => r.kind);
    expect(kinds).toContain("workspace-artifact");
    expect(kinds).toContain("message-attachment");
    expect(kinds.filter((k) => k === "workspace-artifact")).toHaveLength(1);
    expect(kinds).not.toContain("local-file");
  });

  test("private locators never appear in any public display field", async () => {
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [
        {
          kind: "local-file",
          path: "/secret/abs/path.pptx",
          rootPath: "/secret/abs",
          name: "path.pptx",
          relayId: "relay-secret",
        },
        { kind: "workspace-artifact", artifactId: "reports/q3.xlsx" },
      ],
      resolvedArtifactRefs: [],
      attachmentStatuses: [{ id: "att-9", filename: "x.png", decision: "accept", kind: "image" }],
      readableNamespaceIds: ["namespace-readable"],
    });
    for (const entry of manifest) {
      expect(entry.displayName).not.toContain("/secret");
      expect(entry.displayName).not.toContain("relay-secret");
      expect(entry.displayName).not.toContain("att-9");
      // toolTarget.path is bounded workspace path only — never the local abs path.
      if (entry.toolTarget) {
        expect(entry.toolTarget.path).not.toContain("/secret");
      }
    }
  });
});

describe("LocalFileResolver (D423 4.1.3)", () => {
  const localFileRef = {
    kind: "local-file" as const,
    path: "/Users/alice/demo/deck.pptx",
    rootPath: "/Users/alice/demo",
    name: "deck.pptx",
    relayId: "relay-1",
  };

  test("resolves a validated current-zone ref (path under trusted current folder)", async () => {
    const registry = makeMockRegistry([
      { relayId: "relay-1", actorId: "user-1", snapshot: V4_DESKTOP_SNAPSHOT },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest).toHaveLength(1);
    const entry = manifest[0]!;
    expect(entry.kind).toBe("local-file");
    expect(entry.location).toBe("relay");
    expect(entry.lifetime).toBe("turn");
    expect(entry.displayName).toBe("deck.pptx");
    // Capabilities derived from relay tool support, not the file extension.
    expect(entry.capabilities).toEqual(["read", "edit", "convert"]);
    // Model-facing target: current zone with a path RELATIVE to the folder.
    expect(entry.toolTarget).toEqual({
      tool: "file",
      zone: "current",
      path: "deck.pptx",
    });
    // Private locator retains the exact relay id + absolute path; never prompt prose.
    expect(entry.locator).toEqual({ relayId: "relay-1", path: "/Users/alice/demo/deck.pptx" });
  });

  test("resolves a validated absolute-zone ref (path outside current folder)", async () => {
    const registry = makeMockRegistry([
      { relayId: "relay-1", actorId: "user-1", snapshot: V4_DESKTOP_SNAPSHOT },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [
        {
          kind: "local-file",
          path: "/System/Volumes/Data/Data/Temporary/deck.pptx",
          rootPath: "/System/Volumes/Data/Data/Temporary",
          name: "deck.pptx",
          relayId: "relay-1",
        },
      ],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest).toHaveLength(1);
    expect(manifest[0]!.toolTarget).toEqual({
      tool: "file",
      zone: "absolute",
      path: "/System/Volumes/Data/Data/Temporary/deck.pptx",
    });
  });

  test("absolute zone when no current-folder context is set", async () => {
    const registry = makeMockRegistry([
      { relayId: "relay-1", actorId: "user-1", snapshot: V4_DESKTOP_SNAPSHOT },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: null,
      relayRegistry: registry,
    });
    expect(manifest[0]!.toolTarget!.zone).toBe("absolute");
  });

  test("current-zone path is relative to the folder for nested files", async () => {
    const registry = makeMockRegistry([
      { relayId: "relay-1", actorId: "user-1", snapshot: V4_DESKTOP_SNAPSHOT },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [
        {
          kind: "local-file",
          path: "/Users/alice/demo/sub/dir/notes.md",
          rootPath: "/Users/alice/demo",
          name: "notes.md",
          relayId: "relay-1",
        },
      ],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest[0]!.toolTarget).toEqual({
      tool: "file",
      zone: "current",
      path: pathPosixRelative("/Users/alice/demo", "/Users/alice/demo/sub/dir/notes.md"),
    });
  });

  test("capabilities omit convert when the relay lacks canRunOffice", async () => {
    const registry = makeMockRegistry([
      {
        relayId: "relay-1",
        actorId: "user-1",
        snapshot: { ...V4_DESKTOP_SNAPSHOT, canRunOffice: false },
      },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest[0]!.capabilities).toEqual(["read", "edit"]);
  });

  test("client rootPath is never used as authority (advisory only)", async () => {
    const registry = makeMockRegistry([
      { relayId: "relay-1", actorId: "user-1", snapshot: V4_DESKTOP_SNAPSHOT },
    ]);
    // rootPath claims containment in the current folder, but the actual path
    // is elsewhere — the resolver must derive `absolute` from the path + the
    // trusted current folder, NOT from the client-supplied rootPath.
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [
        {
          kind: "local-file",
          path: "/etc/secrets.txt",
          rootPath: "/Users/alice/demo",
          name: "secrets.txt",
          relayId: "relay-1",
        },
      ],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest[0]!.toolTarget!.zone).toBe("absolute");
  });

  test("fails closed when no relay registry is wired (server booted without one)", async () => {
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: null,
    });
    expect(manifest).toEqual([]);
  });

  test("fails closed when no authenticated sender actor is present", async () => {
    const registry = makeMockRegistry([
      { relayId: "relay-1", actorId: "user-1", snapshot: V4_DESKTOP_SNAPSHOT },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: undefined,
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest).toEqual([]);
  });

  test("fails closed when the relay is not connected (snapshot null)", async () => {
    const registry = makeMockRegistry([
      { relayId: "relay-1", actorId: "user-1", snapshot: null },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest).toEqual([]);
  });

  test("fails closed when the relay is owned by a different actor (cross-owner)", async () => {
    const registry = makeMockRegistry([
      {
        relayId: "relay-1",
        actorId: "user-1",
        snapshot: { ...V4_DESKTOP_SNAPSHOT, ownedByActor: false },
      },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest).toEqual([]);
  });

  test("fails closed when the relay protocol is below v4", async () => {
    const registry = makeMockRegistry([
      {
        relayId: "relay-1",
        actorId: "user-1",
        snapshot: { ...V4_DESKTOP_SNAPSHOT, protocolVersion: 3 },
      },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest).toEqual([]);
  });

  test("fails closed when the relay profile is not desktop-agent (headless)", async () => {
    const registry = makeMockRegistry([
      {
        relayId: "relay-1",
        actorId: "user-1",
        snapshot: { ...V4_DESKTOP_SNAPSHOT, profile: "device-relay" },
      },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest).toEqual([]);
  });

  test("fails closed when localFileExecution is false", async () => {
    const registry = makeMockRegistry([
      {
        relayId: "relay-1",
        actorId: "user-1",
        snapshot: { ...V4_DESKTOP_SNAPSHOT, localFileExecution: false },
      },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [localFileRef],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest).toEqual([]);
  });

  test("never discloses relay id or absolute path in the public display field", async () => {
    const registry = makeMockRegistry([
      { relayId: "relay-secret", actorId: "user-1", snapshot: V4_DESKTOP_SNAPSHOT },
    ]);
    const manifest = await resolveFocusedResources({
      focusedResourceRefs: [
        {
          kind: "local-file",
          path: "/Users/alice/demo/secret.pptx",
          rootPath: "/Users/alice/demo",
          name: "secret.pptx",
          relayId: "relay-secret",
        },
      ],
      resolvedArtifactRefs: [],
      attachmentStatuses: [],
      readableNamespaceIds: [],
      senderActorId: "user-1",
      currentFolder: "/Users/alice/demo",
      relayRegistry: registry,
    });
    expect(manifest).toHaveLength(1);
    const entry = manifest[0]!;
    // displayName is basename only — no relay id, no absolute path.
    expect(entry.displayName).toBe("secret.pptx");
    expect(entry.displayName).not.toContain("relay-secret");
    expect(entry.displayName).not.toContain("/Users/alice");
    // Private locator carries both; it never reaches prompt prose.
    expect(entry.locator).toEqual({ relayId: "relay-secret", path: "/Users/alice/demo/secret.pptx" });
  });
});

// `node:path.relative` in the resolver uses the runtime's platform path; tests
// run on POSIX hosts, so the expected relative path mirrors it directly.
function pathPosixRelative(from: string, to: string): string {
  return nodePath.relative(from, to);
}

describe("FocusResolverRegistry extensibility", () => {
  test("adding a future kind requires only registering a resolver", async () => {
    const registry = new FocusResolverRegistry();
    // The default registry already covers workspace-artifact + local-file.
    const def = createDefaultFocusResolverRegistry();
    expect(def.has("workspace-artifact")).toBe(true);
    expect(def.has("local-file")).toBe(true);

    // A custom resolver for a hypothetical future kind plugs in without a
    // composer pipeline change.
    registry.register({
      kind: "workspace-artifact",
      async resolve() {
        return {
          kind: "workspace-artifact",
          displayName: "synthetic",
          location: "server",
          lifetime: "workspace",
          capabilities: ["read"],
          locator: { artifactId: "synthetic" },
        };
      },
    });
    const out = await registry.resolve(
      { kind: "workspace-artifact", artifactId: "synthetic" },
      { readableNamespaceIds: [] },
    );
    expect(out?.displayName).toBe("synthetic");
  });

  test("unknown kind fails closed (returns null, never throws)", async () => {
    const registry = new FocusResolverRegistry();
    const out = await registry.resolve(
      { kind: "workspace-artifact", artifactId: "x" } as never,
      { readableNamespaceIds: [] },
    );
    expect(out).toBeNull();
  });
});
