/**
 * audition_voices tool-card renderer tests.
 */
import "../../../../tests/bun-dom-preload";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AuditionVoicesToolResult, VoiceDiscoveryCandidate } from "@nautilo/types";
import type { ToolRendererProps } from "./types";

const sampleCandidate = (
  overrides: Partial<VoiceDiscoveryCandidate> = {},
): VoiceDiscoveryCandidate => ({
  voiceId: "voice-a",
  name: "Beatriz",
  language: "es",
  languageLabel: "Spanish",
  accent: "peninsular",
  gender: "female",
  age: "young",
  badge: "curated",
  verifiedLanguages: [],
  matchReason: "Peninsular Spanish, warm tone",
  ...overrides,
});

function makeEnvelope(over: Partial<AuditionVoicesToolResult> = {}): AuditionVoicesToolResult {
  return {
    slate: over.slate ?? [sampleCandidate()],
    consideredCount: over.consideredCount ?? 12,
    role: over.role ?? "es",
    ...over,
  };
}

const apiStub = {
  previewVoice: mock(async () => new Blob(["audio"], { type: "audio/mpeg" })),
  upsertVoiceAssignment: mock(async () => ({ voices: {} })),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let ExpandedBody: (typeof import("./audition-voices"))["auditionVoicesRenderer"]["ExpandedBody"];
let parseEnvelope: (typeof import("./audition-voices"))["parseEnvelope"];
let formatCollapsedSummary: (typeof import("./audition-voices"))["formatCollapsedSummary"];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderExpanded(resultText: string, over: Partial<ToolRendererProps> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await rerenderExpanded(resultText, over);
}

async function rerenderExpanded(resultText: string, over: Partial<ToolRendererProps> = {}) {
  if (!root) throw new Error("renderExpanded must run before rerenderExpanded");
  const props: ToolRendererProps = {
    args: {},
    result: undefined,
    state: "success",
    event: undefined,
    resultText,
    resultTruncated: false,
    ...over,
  };
  await act(async () => {
    root!.render(<ExpandedBody {...props} />);
  });
}

async function cleanupExpanded() {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
}

beforeAll(async () => {
  mock.module("../../../lib/api", () => ({
    apiClient: apiStub,
  }));
  const mod = await import("./audition-voices");
  ExpandedBody = mod.auditionVoicesRenderer.ExpandedBody;
  parseEnvelope = mod.parseEnvelope;
  formatCollapsedSummary = mod.formatCollapsedSummary;
});

beforeEach(() => {
  apiStub.previewVoice.mockReset();
  apiStub.upsertVoiceAssignment.mockReset();
  apiStub.previewVoice.mockImplementation(
    async () => new Blob(["audio"], { type: "audio/mpeg" }),
  );
  apiStub.upsertVoiceAssignment.mockImplementation(async () => ({ voices: {} }));
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:mock-audio";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    URL.revokeObjectURL = () => {};
  }
});

afterAll(() => {
  cleanup();
});

describe("parseEnvelope", () => {
  test("happy path returns full audition envelope", () => {
    const env = makeEnvelope({
      slate: [
        sampleCandidate(),
        sampleCandidate({ voiceId: "voice-b", name: "Lucía", badge: "provider_verified" }),
      ],
      suggestedSlate: true,
      sampleText: "Sag: Guten Tag aus Berlin.",
      warnings: ["Some catalog rows look mislabeled."],
    });
    expect(parseEnvelope(JSON.stringify(env))).toEqual(env);
  });

  test("rejects undefined / empty / non-JSON", () => {
    expect(parseEnvelope(undefined)).toBeNull();
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
  });

  test("rejects malformed slate or missing consideredCount", () => {
    expect(parseEnvelope(JSON.stringify({ slate: [], consideredCount: "nope" }))).toBeNull();
    expect(
      parseEnvelope(
        JSON.stringify({
          consideredCount: 1,
          slate: [{ voiceId: "x", name: "X" }],
        }),
      ),
    ).toBeNull();
  });
});

describe("formatCollapsedSummary", () => {
  test("concise summary with candidate count and role", () => {
    const raw = JSON.stringify(makeEnvelope({ role: "es" }));
    expect(formatCollapsedSummary(raw)).toBe("Audition voices · 1 candidate · es");
    expect(
      formatCollapsedSummary(
        JSON.stringify(
          makeEnvelope({
            slate: [sampleCandidate(), sampleCandidate({ voiceId: "voice-b", name: "B" })],
          }),
        ),
      ),
    ).toBe("Audition voices · 2 candidates · es");
  });
});

describe("AuditionVoicesExpanded", () => {
  test("renders four explicit candidates as selectable rows without preview requests", async () => {
    const raw = JSON.stringify(
      makeEnvelope({
        consideredCount: 4,
        slate: [
          sampleCandidate({ voiceId: "voice-a", name: "A" }),
          sampleCandidate({ voiceId: "voice-b", name: "B" }),
          sampleCandidate({ voiceId: "voice-c", name: "C" }),
          sampleCandidate({ voiceId: "voice-d", name: "D" }),
        ],
      }),
    );
    await renderExpanded(raw);
    for (const voiceId of ["voice-a", "voice-b", "voice-c", "voice-d"]) {
      expect(document.querySelector(`[data-testid="audition-voices-row-${voiceId}"]`)).not.toBeNull();
      expect(document.querySelector(`[data-testid="audition-voices-preview-load-${voiceId}"]`)).not.toBeNull();
    }
    expect(apiStub.previewVoice).not.toHaveBeenCalled();
    await cleanupExpanded();
  });

  test("loads only the Human-selected preview", async () => {
    const pending = deferred<Blob>();
    apiStub.previewVoice.mockImplementation(() => pending.promise);
    const raw = JSON.stringify(
      makeEnvelope({
        slate: [
          sampleCandidate({ voiceId: "voice-a", name: "A" }),
          sampleCandidate({ voiceId: "voice-b", name: "B" }),
        ],
      }),
    );
    await renderExpanded(raw);
    expect(apiStub.previewVoice).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audition-voices-preview-load-voice-b"]')!);
    });
    expect(apiStub.previewVoice).toHaveBeenCalledTimes(1);
    expect(apiStub.previewVoice).toHaveBeenCalledWith("voice-b", { text: expect.any(String) });
    expect(document.querySelector('[data-testid="audition-voices-preview-pending-voice-b"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="audition-voices-preview-pending-voice-a"]')).toBeNull();
    pending.resolve(new Blob(["x"], { type: "audio/mpeg" }));
    await cleanupExpanded();
  });

  test("invalidates an in-flight preview when its sample text changes", async () => {
    const firstPreview = deferred<Blob>();
    apiStub.previewVoice.mockImplementation(() => firstPreview.promise);
    const initial = JSON.stringify(
      makeEnvelope({
        sampleText: "First sample",
        slate: [sampleCandidate({ voiceId: "voice-same" })],
      }),
    );
    await renderExpanded(initial);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audition-voices-preview-load-voice-same"]')!);
    });
    expect(apiStub.previewVoice).toHaveBeenCalledWith("voice-same", { text: "First sample" });

    await rerenderExpanded(
      JSON.stringify(
        makeEnvelope({
          sampleText: "Second sample",
          slate: [sampleCandidate({ voiceId: "voice-same" })],
        }),
      ),
    );
    firstPreview.resolve(new Blob(["old"], { type: "audio/mpeg" }));
    await act(async () => {});
    expect(document.querySelector('[data-testid="audition-voices-preview-ready-voice-same"]')).toBeNull();
    expect(document.querySelector('[data-testid="audition-voices-preview-load-voice-same"]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audition-voices-preview-load-voice-same"]')!);
    });
    expect(apiStub.previewVoice).toHaveBeenLastCalledWith("voice-same", { text: "Second sample" });
    await cleanupExpanded();
  });

  test("one preview failure shows retry and does not block another ready row", async () => {
    apiStub.previewVoice.mockImplementation(async (voiceId: string) => {
      if (voiceId === "voice-bad") throw new Error("429");
      return new Blob(["ok"], { type: "audio/mpeg" });
    });
    const raw = JSON.stringify(
      makeEnvelope({
        slate: [
          sampleCandidate({ voiceId: "voice-ok", name: "OK" }),
          sampleCandidate({ voiceId: "voice-bad", name: "Bad" }),
        ],
      }),
    );
    await renderExpanded(raw);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audition-voices-preview-load-voice-ok"]')!);
      fireEvent.click(document.querySelector('[data-testid="audition-voices-preview-load-voice-bad"]')!);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="audition-voices-preview-ready-voice-ok"]'))
        .not.toBeNull();
    });
    expect(
      (document.querySelector('[data-testid="audition-voices-preview-ready-voice-ok"]') as HTMLAudioElement)
        .controls,
    ).toBe(true);
    expect(document.querySelector('[data-testid="audition-voices-preview-failed-voice-bad"]'))
      .not.toBeNull();
    const retry = document.querySelector('[data-testid="audition-voices-preview-retry-voice-bad"]');
    expect(retry).not.toBeNull();
    await act(async () => {
      fireEvent.click(retry!);
    });
    expect(apiStub.previewVoice).toHaveBeenCalledTimes(3);
    expect(apiStub.previewVoice).toHaveBeenLastCalledWith("voice-bad", { text: expect.any(String) });
    expect(document.querySelector('[data-testid="audition-voices-lock-in"]')).not.toBeNull();
    await cleanupExpanded();
  });

  test("preview requests include localized sample text for the candidate language", async () => {
    const raw = JSON.stringify(
      makeEnvelope({
        slate: [sampleCandidate({ voiceId: "voice-de", name: "Deutsch", language: "de", languageLabel: "German" })],
      }),
    );
    await renderExpanded(raw);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audition-voices-preview-load-voice-de"]')!);
    });
    await waitFor(() => {
      expect(apiStub.previewVoice).toHaveBeenCalledWith("voice-de", {
        text: expect.stringContaining("Hallo"),
      });
    });
    await cleanupExpanded();
  });

  test("preview requests prefer Genie-provided sample text from the tool envelope", async () => {
    const raw = JSON.stringify(
      makeEnvelope({
        sampleText: "Sag bitte: Guten Tag, ich bin Jeannie.",
        slate: [sampleCandidate({ voiceId: "voice-de", name: "Deutsch", language: "de", languageLabel: "German" })],
      }),
    );
    await renderExpanded(raw);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audition-voices-preview-load-voice-de"]')!);
    });
    await waitFor(() => {
      expect(apiStub.previewVoice).toHaveBeenCalledWith("voice-de", {
        text: "Sag bitte: Guten Tag, ich bin Jeannie.",
      });
    });
    await cleanupExpanded();
  });

  test("uses provider preview URL if generated sample preview fails", async () => {
    apiStub.previewVoice.mockRejectedValue(new Error("voice not found"));
    const raw = JSON.stringify(
      makeEnvelope({
        slate: [
          sampleCandidate({
            voiceId: "shared-only",
            previewUrl: "https://example.test/provider-preview.mp3",
          }),
        ],
      }),
    );
    await renderExpanded(raw);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audition-voices-preview-load-shared-only"]')!);
    });
    await waitFor(() => {
      const audio = document.querySelector(
        '[data-testid="audition-voices-preview-ready-shared-only"]',
      ) as HTMLAudioElement | null;
      expect(audio?.getAttribute("src")).toBe("https://example.test/provider-preview.mp3");
    });
    await cleanupExpanded();
  });

  test("lock-in calls upsertVoiceAssignment with role and voice ref when preview failed", async () => {
    apiStub.previewVoice.mockImplementation(async (voiceId: string) => {
      if (voiceId === "voice-bad") throw new Error("preview down");
      return new Blob(["ok"], { type: "audio/mpeg" });
    });
    const raw = JSON.stringify(
      makeEnvelope({
        role: "es",
        slate: [
          sampleCandidate({ voiceId: "voice-bad", name: "Bad", badge: "unverified" }),
        ],
      }),
    );
    await renderExpanded(raw);
    const lockBtn = document.querySelector(
      '[data-testid="audition-voices-lock-in"]',
    ) as HTMLButtonElement;
    expect(lockBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(lockBtn);
    });
    await waitFor(() => {
      expect(apiStub.upsertVoiceAssignment).toHaveBeenCalledWith("es", {
        voiceId: "voice-bad",
        voiceName: "Bad",
      });
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="audition-voices-confirmed"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain("Genie's Spanish (es) voice");
    expect(apiStub.previewVoice).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="audition-voices-preview-load-voice-bad"]')).not.toBeNull();
    await cleanupExpanded();
  });

  test("lock-in for default role uses upsertVoiceAssignment with default key", async () => {
    const raw = JSON.stringify(
      makeEnvelope({
        role: "default",
        slate: [sampleCandidate({ voiceId: "voice-primary", name: "Mei" })],
      }),
    );
    await renderExpanded(raw);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="audition-voices-lock-in"]')).not.toBeNull();
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="audition-voices-lock-in"]')!);
    });
    await waitFor(() => {
      expect(apiStub.upsertVoiceAssignment).toHaveBeenCalledWith("default", {
        voiceId: "voice-primary",
        voiceName: "Mei",
      });
    });
    expect(document.body.textContent).toContain("Genie's primary voice");
    await cleanupExpanded();
  });
});
