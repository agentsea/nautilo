import { describe, expect, test } from "bun:test";
import {
  admitGeneratedTakeCandidates,
  generatedTakeFromArtifactReadyStatus,
  generatedTakeLoadStateAfterRetry,
  generatedTakeProgressPresentation,
  reconcileGeneratedTakeElapsedObservation,
  displayedGeneratedTakeElapsedSeconds,
  mergeGeneratedTakeSummaries,
  nextGeneratedTakePollState,
  requestGeneratedTakePreview,
} from "./app";
import type { NautiloAppBridge, NautiloVideoGenerationTakeStatus, NautiloVideoGenerationTakeSummary } from "./bridge";
import { promoteGeneratedTake } from "./commands";
import { createEmptyProject } from "./edl";
import type { GeneratedTake } from "./generation-takes";

const summary: NautiloVideoGenerationTakeSummary = {
  takeId: "take_abcdefghijklmnop",
  shotId: "shot-opening",
  shotLabel: "Opening move",
  documentRevision: 4,
};

function readyStatus(state: "ready" | "cleanup-pending" = "ready"): NautiloVideoGenerationTakeStatus {
  return {
    takeId: summary.takeId,
    revision: 1,
    mediaKind: "video",
    state,
    modelId: "seedance-2-5-text-to-video-basic",
    settings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
    artifact: {
      artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
      path: "generated-media/take-opening.mp4",
      zone: "workspace",
      mime: "video/mp4",
      bytes: 1024,
    },
  };
}

function distinctTake(index: number): GeneratedTake {
  const base = generatedTakeFromArtifactReadyStatus({
    ...summary,
    takeId: `take_${String(index).padStart(16, "a")}`,
    shotId: `shot-${index}`,
    shotLabel: `Take ${index}`,
  }, {
    ...readyStatus(),
    takeId: `take_${String(index).padStart(16, "a")}`,
    artifact: {
      ...readyStatus().artifact!,
      artifactId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      path: `generated-media/take-${index}.mp4`,
    },
  });
  if (!base) throw new Error("fixture must be admissible");
  return base;
}

describe("generated candidate admission and host actions", () => {
  test("admits both ready and cleanup-pending readable artifacts without mutating status", () => {
    const before = readyStatus("ready");
    const completed = generatedTakeFromArtifactReadyStatus(summary, before);
    const cleanup = generatedTakeFromArtifactReadyStatus(summary, readyStatus("cleanup-pending"));
    expect(completed).toMatchObject({ id: summary.takeId, briefRevision: 4, artifact: before.artifact });
    expect(cleanup).toMatchObject({ id: summary.takeId, briefRevision: 4, artifact: before.artifact });
    expect(before.state).toBe("ready");
  });

  test("retains durable lineage when the host list is empty or unavailable", () => {
    const take = generatedTakeFromArtifactReadyStatus(summary, readyStatus());
    if (!take) throw new Error("fixture must be admissible");
    const original: GeneratedTake[] = [take];
    const merged = mergeGeneratedTakeSummaries([], original);
    expect(merged).toEqual([summary]);
    expect(original).toEqual([take]);
  });

  test("admits beyond the old take quota but still rejects duplicate artifacts", () => {
    const overCap = admitGeneratedTakeCandidates([], Array.from({ length: 201 }, (_, index) => distinctTake(index + 1)));
    expect(overCap.takes).toHaveLength(201);
    expect(overCap.rejectedCount).toBe(0);

    const duplicateArtifact = { ...distinctTake(202), artifact: overCap.takes[0]!.artifact };
    const rejected = admitGeneratedTakeCandidates(overCap.takes, [duplicateArtifact]);
    expect(rejected.takes).toEqual(overCap.takes);
    expect(rejected.rejectedCount).toBe(1);
  });

  test("asks only the parent to open a preview by take id", async () => {
    const calls: string[] = [];
    const generation = {
      previewTake: async ({ takeId }: { takeId: string }) => {
        calls.push(takeId);
        return { kind: "opened" as const };
      },
    } satisfies Pick<NonNullable<NautiloAppBridge["videoGeneration"]>, "previewTake">;
    expect(await requestGeneratedTakePreview(generation, summary.takeId)).toBe("opened");
    expect(calls).toEqual([summary.takeId]);
  });

  test("never reports preview opened when the parent declines it", async () => {
    const generation = {
      previewTake: async () => ({ kind: "unavailable" as const, code: "unavailable" }),
    } satisfies Pick<NonNullable<NautiloAppBridge["videoGeneration"]>, "previewTake">;
    expect(await requestGeneratedTakePreview(generation, summary.takeId)).toBe("unavailable");
  });

  test("retries an expiry-style unavailable read, then resumes without requeueing generation", () => {
    const afterExpiry = nextGeneratedTakePollState("retry", 0);
    expect(afterExpiry).toEqual({ shouldPoll: true, retryAttempts: 1 });
    const afterFreshAttestation = nextGeneratedTakePollState("active", afterExpiry.retryAttempts);
    expect(afterFreshAttestation).toEqual({ shouldPoll: true, retryAttempts: 0 });
    expect(nextGeneratedTakePollState("retry", 3)).toEqual({ shouldPoll: false, retryAttempts: 4 });
    expect(nextGeneratedTakePollState("terminal", 0)).toEqual({ shouldPoll: false, retryAttempts: 0 });
    expect(generatedTakeLoadStateAfterRetry()).toBe("unavailable");
  });

  test("renders honest active generation timing without a countdown or percentage", () => {
    const active = generatedTakeProgressPresentation({
      ...readyStatus(),
      state: "generating",
      progress: { phase: "generating", elapsedSeconds: 18, estimatedSeconds: 145 },
    });
    expect(active).toEqual({
      message: "Generation is active.",
      timing: "18s elapsed · Typical time: about 2m 25s",
      isActive: true,
    });

    const delayed = generatedTakeProgressPresentation({
      ...readyStatus(),
      state: "generating",
      progress: { phase: "generating", elapsedSeconds: 146, estimatedSeconds: 145 },
    });
    expect(delayed).toEqual({
      message: "This run is taking longer than typical, but it is still active.",
      timing: "2m 26s elapsed · Typical time: about 2m 25s",
      isActive: true,
    });
  });

  test("uses the durable lifecycle rather than provider messages for active candidate copy", () => {
    expect(generatedTakeProgressPresentation({
      ...readyStatus(),
      state: "queued",
      progress: { phase: "queued", message: "provider-internal" },
    })).toEqual({ message: "Submitted for generation…", timing: null, isActive: true });
    expect(generatedTakeProgressPresentation({ ...readyStatus(), state: "downloading" }))
      .toEqual({ message: "Generation finished—downloading securely.", timing: null, isActive: true });
    expect(generatedTakeProgressPresentation({ ...readyStatus(), state: "saving" }))
      .toEqual({ message: "Saving to Workspace…", timing: null, isActive: true });
    expect(generatedTakeProgressPresentation(readyStatus())).toBeNull();
  });

  test("uses one provider-anchored, monotonic display clock without changing job state", () => {
    const first = reconcileGeneratedTakeElapsedObservation(undefined, 18, 1_000);
    expect(first).toEqual({ elapsedSeconds: 18, observedAtMs: 1_000 });
    expect(displayedGeneratedTakeElapsedSeconds(first, 1_999)).toBe(18);
    expect(displayedGeneratedTakeElapsedSeconds(first, 2_000)).toBe(19);

    const freshBehindDisplay = reconcileGeneratedTakeElapsedObservation(first, 17, 5_000);
    expect(freshBehindDisplay).toEqual({ elapsedSeconds: 22, observedAtMs: 5_000 });
    expect(displayedGeneratedTakeElapsedSeconds(freshBehindDisplay, 6_000)).toBe(23);
    expect(reconcileGeneratedTakeElapsedObservation(freshBehindDisplay, undefined, 7_000)).toBe(freshBehindDisplay);
  });

  test("requires explicit placement and never auto-inserts a completed candidate", () => {
    const take = generatedTakeFromArtifactReadyStatus(summary, readyStatus());
    if (!take) throw new Error("fixture must be admissible");
    const project = { ...createEmptyProject(), generatedTakes: [take] };
    const missingPlacement = promoteGeneratedTake(project, {
      revalidated: { status: "ready", take, durationSec: 5 },
      sequenceId: "",
      trackId: "",
      timelineStartSec: 0,
    });
    expect(missingPlacement.ok).toBe(false);
    expect(project.media).toEqual([]);
    expect(project.sequences[0]!.tracks.flatMap((track) => track.clips)).toEqual([]);

    const placed = promoteGeneratedTake(project, {
      revalidated: { status: "ready", take, durationSec: 5 },
      sequenceId: project.sequences[0]!.id,
      trackId: "track-video",
      timelineStartSec: 0,
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.project.media).toHaveLength(1);
    expect(placed.project.sequences[0]!.tracks.find((track) => track.id === "track-video")!.clips).toHaveLength(1);
  });
});
