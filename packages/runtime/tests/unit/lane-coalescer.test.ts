import { describe, test, expect } from "bun:test";
import {
  LaneCoalescer,
  mergeInputs,
  jobInputToCoalescedInput,
  coalescedInputToJobInput,
  parseFocusedResourcesInput,
  type CoalescedInput,
} from "../../src/lane-coalescer";
import type { ResolvedFocusedResource } from "@nautilo/types";
import type { VerifiedOrdinaryOrigin } from "@nautilo/types";

const ordinaryOrigin = (relayId: string): VerifiedOrdinaryOrigin => ({
  kind: "local_electron",
  userId: "user-1",
  actorId: "actor-1",
  relayId,
  desktopSessionId: "desktop-session-1",
  pairingGeneration: "pairing-1",
  requestId: "request-1",
});

function focusedArtifact(artifactId: string, displayName = artifactId): ResolvedFocusedResource {
  return {
    kind: "workspace-artifact",
    displayName,
    location: "server",
    lifetime: "workspace",
    capabilities: ["read"],
    locator: { artifactId },
  };
}

function focusedAttachment(attachmentId: string, displayName = `${attachmentId}.png`): ResolvedFocusedResource {
  return {
    kind: "message-attachment",
    displayName,
    location: "server",
    lifetime: "message",
    capabilities: ["read"],
    locator: { attachmentId },
  };
}

describe("D302 P4 — humanAlreadyPersisted survives coalescer round-trip", () => {
  test("jobInput → coalesced → jobInput preserves the flag", () => {
    const coalesced = jobInputToCoalescedInput(
      { message: "hi", humanAlreadyPersisted: true },
      "room:r:user:u:bot:b",
      "owner",
      "owner",
    );
    expect(coalesced.humanAlreadyPersisted).toBe(true);
    const back = coalescedInputToJobInput(coalesced);
    expect(back["humanAlreadyPersisted"]).toBe(true);
  });

  test("absent flag stays absent (no accidental skip-persist)", () => {
    const coalesced = jobInputToCoalescedInput(
      { message: "hi" },
      "room:r:user:u:bot:b",
      "owner",
      "owner",
    );
    expect(coalesced.humanAlreadyPersisted).toBeUndefined();
    expect(coalescedInputToJobInput(coalesced)["humanAlreadyPersisted"]).toBeUndefined();
  });
});

describe("D547 — background Task authority survives coalescer round-trip", () => {
  test("preserves the server-authored current Task and originating Room", () => {
    const coalesced = jobInputToCoalescedInput(
      {
        message: "run nested work",
        currentTaskId: "task-parent",
        callingRoomId: "room-origin",
      },
      "task:task-parent",
      "owner",
      "owner",
    );

    expect(coalescedInputToJobInput(coalesced)).toMatchObject({
      currentTaskId: "task-parent",
      callingRoomId: "room-origin",
    });
  });
});

describe("D500 — Auto-Approve posture is an ephemeral, fail-closed turn input", () => {
  test("round-trips only the literal true posture and defaults legacy input off", () => {
    const enabled = jobInputToCoalescedInput(
      { message: "trusted SSH", autoApprove: true },
      "room:r:user:u:bot:b",
      "owner",
      "owner",
    );
    expect(coalescedInputToJobInput(enabled)["autoApprove"]).toBe(true);

    const legacy = jobInputToCoalescedInput(
      { message: "legacy", autoApprove: "true" },
      "room:r:user:u:bot:b",
      "owner",
      "owner",
    );
    expect(legacy.autoApprove).toBe(false);
    expect(coalescedInputToJobInput(legacy)["autoApprove"]).toBe(false);
  });

  test("uses the latest posture for a coalesced Human burst", () => {
    const disabled = mergeInputs([
      baseInput({ laneKey: "L", message: "first", autoApprove: true }),
      baseInput({ laneKey: "L", message: "second", autoApprove: false }),
    ]);
    expect(disabled.autoApprove).toBe(false);

    const enabled = mergeInputs([
      baseInput({ laneKey: "L", message: "first", autoApprove: false }),
      baseInput({ laneKey: "L", message: "second", autoApprove: true }),
    ]);
    expect(enabled.autoApprove).toBe(true);
  });
});

describe("D391 — retainedAttachmentIds survive coalescer round-trip", () => {
  test("jobInput → coalesced → jobInput preserves the ids", () => {
    const coalesced = jobInputToCoalescedInput(
      { message: "hi", retainedAttachmentIds: ["a1", "a2"] },
      "room:r:user:u:bot:b",
      "owner",
      "owner",
    );
    expect(coalesced.retainedAttachmentIds).toEqual(["a1", "a2"]);
    expect(coalescedInputToJobInput(coalesced)["retainedAttachmentIds"]).toEqual(["a1", "a2"]);
  });

  test("absent ids stay absent (no empty-array noise)", () => {
    const coalesced = jobInputToCoalescedInput(
      { message: "hi" },
      "room:r:user:u:bot:b",
      "owner",
      "owner",
    );
    expect(coalesced.retainedAttachmentIds).toBeUndefined();
    expect(coalescedInputToJobInput(coalesced)["retainedAttachmentIds"]).toBeUndefined();
  });
});

describe("M233 — notification provenance survives coalescing", () => {
  test("round-trips causal Human and unions structured mentions", () => {
    const first = baseInput({
      laneKey: "room:r:user:u:bot:b",
      message: "one",
      causalHumanUserId: "human-1",
      mentionedHumanUserIds: ["human-2"],
    });
    const second = baseInput({
      laneKey: "room:r:user:u:bot:b",
      message: "two",
      causalHumanUserId: "human-1",
      mentionedHumanUserIds: ["human-2", "human-3"],
    });
    const merged = mergeInputs([first, second]);
    expect(merged.causalHumanUserId).toBe("human-1");
    expect(merged.mentionedHumanUserIds).toEqual(["human-2", "human-3"]);
    expect(coalescedInputToJobInput(merged)).toMatchObject({
      causalHumanUserId: "human-1",
      mentionedHumanUserIds: ["human-2", "human-3"],
    });
  });

  test("round-trips and ORs Room-wide Human mention intent", () => {
    const parsed = jobInputToCoalescedInput(
      { message: "hello everyone", mentionEveryone: true },
      "room:r:user:u:bot:b",
      "owner",
      "owner",
    );
    expect(parsed.mentionEveryone).toBe(true);
    expect(coalescedInputToJobInput(parsed)["mentionEveryone"]).toBe(true);

    const merged = mergeInputs([
      baseInput({ laneKey: "room:r:user:u:bot:b", mentionEveryone: false }),
      baseInput({ laneKey: "room:r:user:u:bot:b", mentionEveryone: true }),
    ]);
    expect(merged.mentionEveryone).toBe(true);
    expect(coalescedInputToJobInput(merged)["mentionEveryone"]).toBe(true);
  });
});

function baseInput(partial: Partial<Omit<CoalescedInput, "laneKey">> & { laneKey: string }): CoalescedInput {
  return {
    message: "",
    attachmentTextBlocks: [],
    multimodalImages: [],
    ownerId: "o",
    requestorId: "o",
    agentId: "a",
    roomId: "",
    graphThreadId: "g",
    voiceMode: false,
    turnId: "turn",
    actorRole: "owner",
    currentFolder: null,
    currentFolderRelayId: null,
    verifiedOrdinaryOrigin: null,
    workspacePath: null,
    activeMiniApp: null,
    liveMiniAppSession: null,
    artifactRefs: [],
    focusedResources: [],
    securityAuditIp: "",
    securityAuditUserAgent: "",
    threadId: "t",
    roomRoster: [],
    ...partial,
    laneKey: partial.laneKey,
  };
}

describe("M085 — ordinary-origin authority stays a coherent coalesced snapshot", () => {
  test("round-trips current folder, relay id, and validated-origin-shaped payload", () => {
    const origin = ordinaryOrigin("relay-a");
    const coalesced = jobInputToCoalescedInput({
      message: "hi",
      currentFolder: "/project-a",
      currentFolderRelayId: "relay-a",
      verifiedOrdinaryOrigin: origin,
    }, "lk", "o", "o");

    expect(coalescedInputToJobInput(coalesced)).toMatchObject({
      currentFolder: "/project-a",
      currentFolderRelayId: "relay-a",
      verifiedOrdinaryOrigin: origin,
    });
  });

  test("keeps the first segment's folder/relay/origin together rather than mixing authority", () => {
    const first = baseInput({
      laneKey: "L",
      message: "first",
      currentFolder: "/project-a",
      currentFolderRelayId: "relay-a",
      verifiedOrdinaryOrigin: ordinaryOrigin("relay-a"),
    });
    const second = baseInput({
      laneKey: "L",
      message: "second",
      currentFolder: "/project-b",
      currentFolderRelayId: "relay-b",
      verifiedOrdinaryOrigin: ordinaryOrigin("relay-b"),
    });

    expect(mergeInputs([first, second])).toMatchObject({
      currentFolder: "/project-a",
      currentFolderRelayId: "relay-a",
      verifiedOrdinaryOrigin: ordinaryOrigin("relay-a"),
    });
  });
});

describe("D356 — artifactRefs survive coalescing (union, dedupe by id)", () => {
  test("mergeInputs unions refs across burst segments and dedupes by artifactId", () => {
    const merged = mergeInputs([
      baseInput({
        laneKey: "L",
        message: "a",
        artifactRefs: [{ artifactId: "x/1", path: "x/1.md", mimeType: "text/markdown", size: 1 }],
      }),
      baseInput({
        laneKey: "L",
        message: "b",
        artifactRefs: [
          { artifactId: "x/1", path: "x/1.md", mimeType: "text/markdown", size: 1 },
          { artifactId: "y/2", path: "y/2.csv", mimeType: "text/csv", size: 2 },
        ],
      }),
    ]);
    expect(merged.artifactRefs?.map((r) => r.artifactId)).toEqual(["x/1", "y/2"]);
  });

  test("jobInput → coalesced → jobInput round-trips refs; absence is an explicit clear", () => {
    const refs = [{ artifactId: "a/b", path: "a/b.pdf", mimeType: "application/pdf", size: 9 }];
    const coalesced = jobInputToCoalescedInput(
      { message: "hi", artifactRefs: refs },
      "room:r:user:u:bot:b",
      "owner",
      "owner",
    );
    expect(coalesced.artifactRefs).toEqual(refs);
    expect(coalescedInputToJobInput(coalesced)["artifactRefs"]).toEqual(refs);

    const none = jobInputToCoalescedInput({ message: "hi" }, "lk", "o", "o");
    expect(none.artifactRefs).toEqual([]);
    expect(coalescedInputToJobInput(none)["artifactRefs"]).toEqual([]);
  });

  test("malformed ref entries are dropped on parse", () => {
    const coalesced = jobInputToCoalescedInput(
      {
        message: "hi",
        artifactRefs: [
          { artifactId: "ok", path: "ok.txt", mimeType: "text/plain", size: 3 },
          { artifactId: "", path: "bad", mimeType: "text/plain", size: 3 },
          { path: "no-id.txt", mimeType: "text/plain", size: 3 },
          "garbage",
        ],
      },
      "lk",
      "o",
      "o",
    );
    expect(coalesced.artifactRefs?.map((r) => r.artifactId)).toEqual(["ok"]);
  });
});

describe("LaneCoalescer", () => {
  test("drainLane clears buffer without calling onFlush", () => {
    const flushed: string[] = [];
    const stubTimer = ((_fn: (...args: unknown[]) => void) =>
      999 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;

    const c = new LaneCoalescer(stubTimer, clearTimeout, (_lk, merged) => {
      flushed.push(merged.message);
    }, 100);

    c.enqueue(baseInput({ laneKey: "L", message: "a" }), "v1");
    const drained = c.drainLane("L");
    expect(flushed).toEqual([]);
    expect(drained?.merged.message).toBe("a");
    expect(drained?.virtualJobIds).toEqual(["v1"]);
    expect(c.drainLane("L")).toBeNull();
  });

  test("dropLanesForRoom clears matching room buffers without flushing", () => {
    const flushed: string[] = [];
    const stubTimer = ((_fn: (...args: unknown[]) => void) =>
      999 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;

    const c = new LaneCoalescer(stubTimer, clearTimeout, (lk, merged) => {
      flushed.push(`${lk}:${merged.message}`);
    }, 100);

    c.enqueue(baseInput({ laneKey: "room:r1:user:u1:bot:b", message: "a" }), "v1");
    c.enqueue(baseInput({ laneKey: "room:r2:user:u1:bot:b", message: "b" }), "v2");

    expect(c.dropLanesForRoom("r1").lanes).toBe(1);
    c.flushIfPending("room:r1:user:u1:bot:b");
    c.flushIfPending("room:r2:user:u1:bot:b");
    expect(flushed).toEqual(["room:r2:user:u1:bot:b:b"]);
  });

  test("single enqueue → timer fires → one flush", () => {
    let fired: (() => void) | null = null;
    const flushed: string[] = [];
    const stubTimer = ((fn: (...args: unknown[]) => void, ms?: number) => {
      expect(ms).toBe(100);
      fired = fn as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c: LaneCoalescer = new LaneCoalescer(stubTimer, clearTimeout, (laneKey, merged) => {
      flushed.push(`${laneKey}:${merged.message}`);
    }, 100);

    c.enqueue(baseInput({ laneKey: "L", message: "one" }), "v1");
    expect(flushed).toEqual([]);
    (fired as (() => void) | null)?.();
    expect(flushed).toEqual(["L:one"]);
  });

  test("sliding silence — second append resets deadline", () => {
    let t = 0;
    let deadline = 0;
    let onFire: (() => void) | null = null;
    const flushed: string[] = [];
    const stubTimer = ((fn: (...args: unknown[]) => void, ms?: number) => {
      deadline = t + (ms ?? 0);
      onFire = fn as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c: LaneCoalescer = new LaneCoalescer(stubTimer, clearTimeout, (_lk, merged) => {
      flushed.push(merged.message);
    }, 100);

    t = 0;
    c.enqueue(baseInput({ laneKey: "L", message: "a" }), "v1");
    expect(deadline).toBe(100);
    t = 99;
    c.enqueue(baseInput({ laneKey: "L", message: "b" }), "v2");
    expect(deadline).toBe(199);
    t = 199;
    (onFire as (() => void) | null)?.();
    expect(flushed).toEqual(["a\n\nb"]);
  });

  test("three enqueues merge in flush callback", async () => {
    let mergedCapture: CoalescedInput | null = null;
    const stubTimer = ((fn: (...args: unknown[]) => void) => {
      queueMicrotask(fn as () => void);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c: LaneCoalescer = new LaneCoalescer(stubTimer, clearTimeout, (_lk, merged) => {
      mergedCapture = merged;
    }, 10);

    c.enqueue(
      baseInput({
        laneKey: "x",
        message: "m1",
        attachmentTextBlocks: ["t1"],
        multimodalImages: [
          { type: "image", attachmentId: "i1", filename: "a.png", mimeType: "image/png", base64: "qq" },
        ],
        retainedAttachmentIds: ["i1"],
      }),
      "v1",
    );
    c.enqueue(
      baseInput({
        laneKey: "x",
        message: "m2",
        attachmentTextBlocks: ["t2"],
        multimodalImages: [
          { type: "image", attachmentId: "i1", filename: "a.png", mimeType: "image/png", base64: "qq" },
          { type: "image", attachmentId: "i2", filename: "b.png", mimeType: "image/png", base64: "rr" },
        ],
        retainedAttachmentIds: ["i1", "i2"],
      }),
      "v2",
    );
    c.enqueue(baseInput({ laneKey: "x", message: "m3" }), "v3");

    await new Promise((r) => queueMicrotask(r));
    expect(mergedCapture).not.toBeNull();
    expect(mergedCapture!.message).toBe("m1\n\nm2\n\nm3");
    expect(mergedCapture!.attachmentTextBlocks).toEqual(["t1", "t2"]);
    expect(mergedCapture!.multimodalImages.map((i) => i.attachmentId)).toEqual(["i1", "i2"]);
    // D391 — retained attachment ids are unioned (dedupe) across segments so a
    // coalesced turn's single human row stamps all of them.
    expect(mergedCapture!.retainedAttachmentIds).toEqual(["i1", "i2"]);
  });

  test("flushIfPending runs immediately and clears timer", () => {
    let cleared = 0;
    let tid = 0 as unknown as ReturnType<typeof setTimeout>;
    const stubTimer = ((fn: (...args: unknown[]) => void) => {
      tid = setTimeout(fn as () => void, 9999) as unknown as ReturnType<typeof setTimeout>;
      return tid;
    }) as unknown as typeof setTimeout;

    const stubClear = ((id: ReturnType<typeof setTimeout>) => {
      cleared++;
      clearTimeout(id);
    }) as typeof clearTimeout;

    const flushed: string[] = [];
    const c: LaneCoalescer = new LaneCoalescer(stubTimer, stubClear, (lk, m) => flushed.push(`${lk}:${m.message}`), 999);
    c.enqueue(baseInput({ laneKey: "z", message: "x" }), "v");
    c.flushIfPending("z");
    expect(flushed).toEqual(["z:x"]);
    c.flushIfPending("z");
    expect(flushed).toEqual(["z:x"]);
    expect(cleared).toBe(1);
  });

  test("two laneKeys flush independently", async () => {
    const out: string[] = [];
    const stubTimer = ((fn: (...args: unknown[]) => void) => {
      queueMicrotask(fn as () => void);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c: LaneCoalescer = new LaneCoalescer(stubTimer, clearTimeout, (lk, m) => out.push(`${lk}:${m.message}`), 5);
    c.enqueue(baseInput({ laneKey: "a", message: "1" }), "v1");
    c.enqueue(baseInput({ laneKey: "b", message: "2" }), "v2");
    await new Promise((r) => queueMicrotask(r));
    expect(out.sort()).toEqual(["a:1", "b:2"]);
  });

  test("mergeInputs single entry returns same reference", () => {
    const a = baseInput({ laneKey: "q", message: "solo" });
    expect(mergeInputs([a])).toBe(a);
  });

  test("first-write-wins metadata fields", () => {
    const merged = mergeInputs([
      baseInput({
        laneKey: "q",
        message: "a",
        voiceMode: true,
        turnId: "t1",
        actorRole: "owner",
        currentFolder: "/a",
        workspacePath: "/w",
        activeMiniApp: { appId: "first", updatedAt: 1 },
      }),
      baseInput({
        laneKey: "q",
        message: "b",
        voiceMode: false,
        turnId: "t2",
        actorRole: "guest",
        currentFolder: "/b",
        workspacePath: "/x",
        activeMiniApp: { appId: "second", updatedAt: 2 },
      }),
    ]);
    expect(merged.message).toBe("a\n\nb");
    expect(merged.voiceMode).toBe(true);
    expect(merged.turnId).toBe("t1");
    expect(merged.actorRole).toBe("owner");
    expect(merged.currentFolder).toBe("/a");
    expect(merged.workspacePath).toBe("/w");
    expect(merged.activeMiniApp?.appId).toBe("first");
  });

  test("jobInput round-trip preserves present active-mini-app and live-session context", () => {
    const activeMiniApp = {
      appId: "sample-app",
      appName: "Sample App",
      updatedAt: 1,
    };
    const liveMiniAppSession = {
      appId: "sample-app",
      sessionToken: "session-token",
      sessionId: "session-id",
      documentVersion: { kind: "artifact_revision" as const, revision: 1 },
      instructions: "Review the document.",
    };
    const coalesced = jobInputToCoalescedInput(
      { message: "hi", activeMiniApp, liveMiniAppSession },
      "room:r",
      "owner",
      "owner",
    );
    expect(coalesced.activeMiniApp).toEqual(activeMiniApp);
    expect(coalescedInputToJobInput(coalesced)["activeMiniApp"]).toEqual(activeMiniApp);
    expect(coalesced.liveMiniAppSession).toEqual(liveMiniAppSession);
    expect(coalescedInputToJobInput(coalesced)["liveMiniAppSession"]).toEqual(liveMiniAppSession);
  });

  test("jobInput round-trip keeps absent ephemeral context as explicit graph clears", () => {
    const coalesced = jobInputToCoalescedInput(
      { message: "hi", activeMiniApp: null, liveMiniAppSession: null },
      "room:r",
      "owner",
      "owner",
    );

    expect(coalesced.activeMiniApp).toBeNull();
    expect(coalesced.liveMiniAppSession).toBeNull();
    expect(coalescedInputToJobInput(coalesced)).toMatchObject({
      activeMiniApp: null,
      liveMiniAppSession: null,
    });
  });

  test("rebufferMergedAfterRace schedules full window", () => {
    const scheduled: number[] = [];
    const stubTimer = ((_fn: (...args: unknown[]) => void, ms?: number) => {
      scheduled.push(ms ?? 0);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c: LaneCoalescer = new LaneCoalescer(stubTimer, clearTimeout, () => {}, 2000);
    c.rebufferMergedAfterRace(
      "rb",
      baseInput({ laneKey: "rb", message: "m" }),
      ["va", "vb", "vc"],
    );
    expect(scheduled[scheduled.length - 1]).toBe(2000);
  });
});

describe("D423 — focusedResources (resolved manifest) survive coalescer round-trip", () => {
  test("parseFocusedResourcesInput drops malformed entries", () => {
    const out = parseFocusedResourcesInput([
      focusedArtifact("a/1"),
      { kind: "workspace-artifact", displayName: "", location: "server", lifetime: "workspace", capabilities: ["read"], locator: {} },
      { kind: "weird", displayName: "x", location: "server", lifetime: "workspace", capabilities: [], locator: {} },
      "garbage",
    ]);
    expect(out.map((r) => (r.locator as { artifactId?: string }).artifactId)).toEqual(["a/1"]);
  });

  test("jobInput → coalesced → jobInput round-trips the manifest", () => {
    const manifest = [focusedArtifact("a/1"), focusedAttachment("att-1")];
    const coalesced = jobInputToCoalescedInput(
      { message: "hi", focusedResources: manifest },
      "room:r:user:u:bot:b",
      "owner",
      "owner",
    );
    expect(coalesced.focusedResources).toEqual(manifest);
    expect(coalescedInputToJobInput(coalesced)["focusedResources"]).toEqual(manifest);
  });

  test("absent manifest becomes an explicit clear", () => {
    const coalesced = jobInputToCoalescedInput({ message: "hi" }, "lk", "o", "o");
    expect(coalesced.focusedResources).toEqual([]);
    expect(coalescedInputToJobInput(coalesced)["focusedResources"]).toEqual([]);
  });

  test("mergeInputs unions manifest entries across burst segments, kind-specific dedupe", () => {
    const merged = mergeInputs([
      baseInput({
        laneKey: "L",
        message: "a",
        focusedResources: [focusedArtifact("x/1"), focusedAttachment("att-1")],
      }),
      baseInput({
        laneKey: "L",
        message: "b",
        focusedResources: [
          focusedArtifact("x/1"), // dup → collapsed
          focusedArtifact("y/2"),
          focusedAttachment("att-1"), // dup → collapsed
        ],
      }),
    ]);
    const keys = merged.focusedResources?.map((r) => `${r.kind}:${(r.locator as { artifactId?: string; attachmentId?: string }).artifactId ?? (r.locator as { attachmentId?: string }).attachmentId}`);
    expect(keys).toEqual(["workspace-artifact:x/1", "message-attachment:att-1", "workspace-artifact:y/2"]);
  });
});


test("Memory admission retains all already-persisted Human sources across coalescing", () => {
  const segments = [
    { currentMessageId: 11, memoryReviewSourceMessageIds: [10, 11] },
    { currentMessageId: 12 },
  ].map((coordinates) => jobInputToCoalescedInput({ message: "human", humanAlreadyPersisted: true, ...coordinates }, "room:r:user:u:bot:b", "owner", "owner"));
  const merged = coalescedInputToJobInput(mergeInputs(segments));
  expect(merged["currentMessageId"]).toBe(12);
  expect(merged["memoryReviewSourceMessageIds"]).toEqual([10, 11, 12]);
  expect(merged["humanAlreadyPersisted"]).toBe(true);
});
