/**
 * D215 — VoiceCatalogModal unit tests.
 */
import "../../../tests/bun-dom-preload";
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
import type { CatalogQuery, CatalogResponse, CatalogVoice } from "@nautilo/types";
import { ApiError } from "@nautilo/api-client/browser";

const sampleVoice = (
  overrides: Partial<CatalogVoice> = {},
): CatalogVoice => ({
  voiceId: "voice-1",
  name: "Lucia",
  accent: "neutral",
  gender: "female",
  age: "young",
  descriptive: "warm",
  category: "professional",
  language: "es",
  locale: "es-ES",
  languageLabel: "Spanish",
  previewUrl: "https://example.com/preview.mp3",
  verifiedLanguages: [],
  source: "provider",
  ...overrides,
});

const catalogResponse = (
  overrides: Partial<CatalogResponse> = {},
): CatalogResponse => ({
  voices: [sampleVoice()],
  languageGroups: [
    { language: "en", locale: null, label: "English", count: 10 },
    { language: "es", locale: "es-ES", label: "Spanish (ES)", count: 5 },
  ],
  page: 0,
  pageSize: 30,
  hasMore: false,
  totalCount: 1,
  elevenLabsConfigured: true,
  cachedAt: Date.now(),
  ...overrides,
});

const apiStub = {
  listVoiceCatalog: mock(async () => catalogResponse()),
  upsertVoiceAssignment: mock(async () => ({ voices: {} })),
  previewVoice: mock(async () => new Blob(["audio"], { type: "audio/mpeg" })),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let VoiceCatalogModal: (typeof import("./voice-catalog-modal"))["VoiceCatalogModal"];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderModal(props?: {
  onAssigned?: () => void | Promise<void>;
  onClose?: () => void;
  roleAtAssign?: boolean;
  initialLanguage?: string | null;
  defaultAssignRole?: string;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onAssigned = props?.onAssigned ?? (async () => {});
  const onClose = props?.onClose ?? (() => {});
  await act(async () => {
    root!.render(
      <VoiceCatalogModal
        open
        onClose={onClose}
        onAssigned={onAssigned}
        roleAtAssign={props?.roleAtAssign}
        initialLanguage={props?.initialLanguage}
        defaultAssignRole={props?.defaultAssignRole}
      />,
    );
  });
}

async function cleanupModal() {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
}

beforeAll(async () => {
  mock.module("../../lib/api", () => ({
    apiClient: apiStub,
  }));
  ({ VoiceCatalogModal } = await import("./voice-catalog-modal"));
});

beforeEach(() => {
  apiStub.listVoiceCatalog.mockReset();
  apiStub.upsertVoiceAssignment.mockReset();
  apiStub.previewVoice.mockReset();
  apiStub.listVoiceCatalog.mockImplementation(async () => catalogResponse());
  apiStub.upsertVoiceAssignment.mockImplementation(async () => ({ voices: {} }));
  apiStub.previewVoice.mockImplementation(
    async () => new Blob(["audio"], { type: "audio/mpeg" }),
  );
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

describe("VoiceCatalogModal", () => {
  test("binds catalog surfaces to Workbench theme tokens before legacy fallbacks", async () => {
    // happy-dom drops nested var() fallbacks from CSSStyleDeclaration, so verify
    // the shared package's inline-style contract at its source boundary.
    const source = await Bun.file(
      new URL(
        "../../../../../packages/voice-catalog-ui/src/voice-catalog-modal.tsx",
        import.meta.url,
      ),
    ).text();

    expect(source).toContain(
      'background: "var(--background-panel, var(--bg-panel, #111827))"',
    );
    expect(source.match(
      /background: "var\(--background, var\(--bg, #0b1020\)\)"/g,
    )).toHaveLength(3);
    expect(source).toContain(
      'color: "var(--foreground, var(--text, white))"',
    );
  });

  test("shows missing-key copy on 400 without ElevenLabs key", async () => {
    apiStub.listVoiceCatalog.mockImplementation(async () => {
      throw new ApiError(400, "ELEVENLABS_API_KEY is not set");
    });
    await renderModal();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-catalog-missing-key"]'),
      ).not.toBeNull();
    });
    expect(document.body.textContent).toContain(
      "Configure your ElevenLabs API key in Providers",
    );
    await cleanupModal();
  });

  test("language group selection updates showing label", async () => {
    await renderModal();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-showing"]'))
        .not.toBeNull();
    });
    expect(document.body.textContent).toContain(
      "Provider counts; badges show language verification metadata.",
    );
    expect(document.querySelector('[data-testid="voice-catalog-showing"]')?.textContent).toContain(
      "All languages",
    );
    expect(document.querySelector('[data-testid="voice-catalog-lang-all"]'))
      .not.toBeNull();
    const spanishBtn = document.querySelector(
      '[data-testid="voice-catalog-lang-es:es-ES"]',
    );
    expect(spanishBtn).not.toBeNull();
    await act(async () => {
      fireEvent.click(spanishBtn!);
    });
    await waitFor(() => {
      const showing = document.querySelector(
        '[data-testid="voice-catalog-showing"]',
      );
      expect(showing?.textContent).toContain("Spanish (ES)");
    });
    const allBtn = document.querySelector('[data-testid="voice-catalog-lang-all"]');
    await act(async () => {
      fireEvent.click(allBtn!);
    });
    await waitFor(() => {
      const showing = document.querySelector(
        '[data-testid="voice-catalog-showing"]',
      );
      expect(showing?.textContent).toContain("All languages");
    });
    await cleanupModal();
  });

  test("revisiting a cached language restores rows without blank loading", async () => {
    const allRefresh = deferred<CatalogResponse>();
    let allRequests = 0;
    apiStub.listVoiceCatalog.mockImplementation(async (query?: CatalogQuery) => {
      if (query?.language === "es") {
        return catalogResponse({
          voices: [sampleVoice({ voiceId: "spanish-row", name: "Spanish Row" })],
        });
      }
      allRequests += 1;
      if (allRequests === 1) {
        return catalogResponse({
          voices: [sampleVoice({ voiceId: "all-row", name: "All Row" })],
        });
      }
      return allRefresh.promise;
    });

    await renderModal();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-row-all-row"]'))
        .not.toBeNull();
    });

    const spanishBtn = document.querySelector(
      '[data-testid="voice-catalog-lang-es:es-ES"]',
    );
    await act(async () => {
      fireEvent.click(spanishBtn!);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-row-spanish-row"]'))
        .not.toBeNull();
    });

    const allBtn = document.querySelector('[data-testid="voice-catalog-lang-all"]');
    await act(async () => {
      fireEvent.click(allBtn!);
    });

    expect(document.querySelector('[data-testid="voice-catalog-row-all-row"]'))
      .not.toBeNull();
    expect(document.querySelector('[data-testid="voice-catalog-empty"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Loading...");
    expect(document.querySelector('[data-testid="voice-catalog-refreshing"]'))
      .not.toBeNull();

    await act(async () => {
      allRefresh.resolve(catalogResponse({
        voices: [sampleVoice({ voiceId: "all-row-refreshed", name: "All Row Refreshed" })],
      }));
      await allRefresh.promise;
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-row-all-row-refreshed"]'))
        .not.toBeNull();
    });
    await cleanupModal();
  });

  test("cached query preserves loaded Load More rows when revisited", async () => {
    let allRequests = 0;
    const allRefresh = deferred<CatalogResponse>();
    apiStub.listVoiceCatalog.mockImplementation(async (query?: CatalogQuery) => {
      if (query?.language === "es") {
        return catalogResponse({
          voices: [sampleVoice({ voiceId: "spanish-only", name: "Spanish Only" })],
        });
      }
      allRequests += 1;
      if (query?.page === 1) {
        return catalogResponse({
          voices: [sampleVoice({ voiceId: "all-page-1", name: "All Page 1" })],
          page: 1,
          hasMore: false,
        });
      }
      if (allRequests > 1) return allRefresh.promise;
      return catalogResponse({
        voices: [sampleVoice({ voiceId: `all-page-0-${allRequests}`, name: "All Page 0" })],
        page: 0,
        hasMore: true,
      });
    });

    await renderModal();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-row-all-page-0-1"]'))
        .not.toBeNull();
    });
    const loadMore = document.querySelector(
      '[data-testid="voice-catalog-load-more"]',
    )?.closest("button");
    await act(async () => {
      fireEvent.click(loadMore!);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-row-all-page-1"]'))
        .not.toBeNull();
    });

    const spanishBtn = document.querySelector(
      '[data-testid="voice-catalog-lang-es:es-ES"]',
    );
    await act(async () => {
      fireEvent.click(spanishBtn!);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-row-spanish-only"]'))
        .not.toBeNull();
    });

    const allBtn = document.querySelector('[data-testid="voice-catalog-lang-all"]');
    await act(async () => {
      fireEvent.click(allBtn!);
    });
    expect(document.querySelector('[data-testid="voice-catalog-row-all-page-0-1"]'))
      .not.toBeNull();
    expect(document.querySelector('[data-testid="voice-catalog-row-all-page-1"]'))
      .not.toBeNull();
    expect(document.body.textContent).not.toContain("Loading...");
    await act(async () => {
      allRefresh.resolve(catalogResponse({
        voices: [sampleVoice({ voiceId: "all-page-0-refreshed", name: "All Page 0 Refreshed" })],
        page: 0,
        hasMore: true,
      }));
      await allRefresh.promise;
    });
    await cleanupModal();
  });

  test("renders empty state when no voices match", async () => {
    apiStub.listVoiceCatalog.mockImplementation(async () =>
      catalogResponse({ voices: [], totalCount: 0 }),
    );
    await renderModal();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-catalog-empty"]'),
      ).not.toBeNull();
    });
    expect(document.body.textContent).toContain(
      "No voices match",
    );
    await cleanupModal();
  });

  test("preview button generates sample when provider previewUrl is null", async () => {
    apiStub.listVoiceCatalog.mockImplementation(async () =>
      catalogResponse({
        voices: [sampleVoice({ voiceId: "no-preview", previewUrl: null })],
      }),
    );
    await renderModal();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-catalog-row-no-preview"]'),
      ).not.toBeNull();
    });
    const previewWrap = document.querySelector(
      '[data-testid="voice-catalog-preview-no-preview"] button',
    ) as HTMLButtonElement | null;
    expect(previewWrap?.disabled).toBe(false);
    await act(async () => {
      previewWrap?.click();
    });
    await waitFor(() => {
      expect(apiStub.previewVoice).toHaveBeenCalledWith("no-preview", {
        text: expect.any(String),
      });
    });
    await cleanupModal();
  });

  test("role-at-assign saves Spanish language voice after select and Save", async () => {
    apiStub.listVoiceCatalog.mockImplementation(async (query?: CatalogQuery) => {
      if (query?.language === "es") {
        return catalogResponse({
          voices: [
            sampleVoice({
              voiceId: "voice-es",
              verifiedLanguages: [{ language: "es", modelId: "eleven_v3", accent: null, locale: "es-ES", previewUrl: null }],
            }),
          ],
        });
      }
      return catalogResponse();
    });
    let assigned = false;
    const onClose = mock(() => {});
    await renderModal({
      roleAtAssign: true,
      initialLanguage: "es",
      defaultAssignRole: "es",
      onAssigned: async () => {
        assigned = true;
      },
      onClose,
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-lang-es:es-ES"]'))
        .not.toBeNull();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-row-voice-es"]'))
        .not.toBeNull();
    });
    expect(
      document.querySelector('[data-testid="voice-catalog-verified-voice-es"]'),
    ).not.toBeNull();
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-testid="voice-catalog-select-voice-es"] button')!,
      );
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-assign-footer"]'))
        .not.toBeNull();
    });
    const langRadio = document.querySelector(
      '[data-testid="voice-catalog-assign-role-lang"]',
    ) as HTMLInputElement;
    expect(langRadio.checked).toBe(true);
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-testid="voice-catalog-save-assign"]')!,
      );
    });
    await waitFor(() => {
      expect(apiStub.upsertVoiceAssignment).toHaveBeenCalledWith("es", {
        voiceId: "voice-es",
        voiceName: "Lucia",
      });
      expect(assigned).toBe(true);
      expect(onClose).toHaveBeenCalled();
    });
    await cleanupModal();
  });

  test("shows unverified badge when voice lacks provider v3 metadata", async () => {
    apiStub.listVoiceCatalog.mockImplementation(async (query?: CatalogQuery) => {
      if (query?.language === "es") {
        return catalogResponse({
          voices: [sampleVoice({ voiceId: "voice-unverified", verifiedLanguages: [] })],
        });
      }
      return catalogResponse();
    });
    await renderModal({ roleAtAssign: true, initialLanguage: "es" });
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-catalog-unverified-voice-unverified"]'),
      ).not.toBeNull();
    });
    expect(document.body.textContent).toContain("not provider v3-verified for es");
    await cleanupModal();
  });

  test("shows curated badge for Nautilo-tested voices", async () => {
    apiStub.listVoiceCatalog.mockImplementation(async (query?: CatalogQuery) => {
      if (query?.language === "es") {
        return catalogResponse({
          voices: [sampleVoice({ voiceId: "voice-curated", source: "curated", verifiedLanguages: [] })],
        });
      }
      return catalogResponse();
    });
    await renderModal({ roleAtAssign: true, initialLanguage: "es" });
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-catalog-curated-voice-curated"]'),
      ).not.toBeNull();
    });
    expect(document.body.textContent).toContain("Curated / tested");
    await cleanupModal();
  });

  test("orders curated, provider-v3-verified, then unverified voices", async () => {
    apiStub.listVoiceCatalog.mockImplementation(async (query?: CatalogQuery) => {
      if (query?.language === "es") {
        return catalogResponse({
          voices: [
            sampleVoice({ voiceId: "unverified", name: "Unverified", verifiedLanguages: [] }),
            sampleVoice({
              voiceId: "verified",
              name: "Verified",
              verifiedLanguages: [{ language: "es", modelId: "eleven_v3", accent: null, locale: "es-ES", previewUrl: null }],
            }),
            sampleVoice({ voiceId: "curated", name: "Curated", source: "curated", verifiedLanguages: [] }),
          ],
        });
      }
      return catalogResponse();
    });

    await renderModal({ roleAtAssign: true, initialLanguage: "es" });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="voice-catalog-row-curated"]'))
        .not.toBeNull();
    });
    const ids = [...document.querySelectorAll('[data-testid^="voice-catalog-row-"]')]
      .map((el) => el.getAttribute("data-testid"));
    expect(ids.slice(0, 3)).toEqual([
      "voice-catalog-row-curated",
      "voice-catalog-row-verified",
      "voice-catalog-row-unverified",
    ]);
    await cleanupModal();
  });

  test("Use this voice calls upsertVoiceAssignment and onAssigned", async () => {
    let assigned = false;
    const onClose = mock(() => {});
    await renderModal({
      onAssigned: async () => {
        assigned = true;
      },
      onClose,
    });
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-catalog-use-voice-1"] button'),
      ).not.toBeNull();
    });
    const useBtn = document.querySelector(
      '[data-testid="voice-catalog-use-voice-1"] button',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(useBtn);
    });
    await waitFor(() => {
      expect(apiStub.upsertVoiceAssignment).toHaveBeenCalledWith("default", {
        voiceId: "voice-1",
        voiceName: "Lucia",
      });
      expect(assigned).toBe(true);
      expect(onClose).toHaveBeenCalled();
    });
    await cleanupModal();
  });

  test("Generate Genie sample calls previewVoice with language phrase", async () => {
    await renderModal();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-catalog-genie-sample-voice-1"] button'),
      ).not.toBeNull();
    });
    const genieBtn = document.querySelector(
      '[data-testid="voice-catalog-genie-sample-voice-1"] button',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(genieBtn);
    });
    await waitFor(() => {
      expect(apiStub.previewVoice).toHaveBeenCalledWith("voice-1", {
        text: expect.stringContaining("[laughs]"),
      });
    });
    const call = apiStub.previewVoice.mock.calls[0] as [
      string,
      { text: string },
    ];
    expect(call[1].text).toContain("Genio");
    await cleanupModal();
  });

  test("Generate Genie sample uses translated phrase for Korean", async () => {
    apiStub.listVoiceCatalog.mockImplementation(async () =>
      catalogResponse({
        voices: [
          sampleVoice({
            voiceId: "voice-ko",
            language: "ko",
            locale: "ko-KR",
            languageLabel: "Korean",
          }),
        ],
      }),
    );
    await renderModal();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-catalog-genie-sample-voice-ko"] button'),
      ).not.toBeNull();
    });
    const genieBtn = document.querySelector(
      '[data-testid="voice-catalog-genie-sample-voice-ko"] button',
    ) as HTMLButtonElement;
    expect(genieBtn.disabled).toBe(false);
    expect(genieBtn.title).toBe("");
    expect(genieBtn.textContent).toContain("Generate Genie sample");
    await act(async () => {
      fireEvent.click(genieBtn);
    });
    await waitFor(() => {
      expect(apiStub.previewVoice).toHaveBeenCalledWith("voice-ko", {
        text: expect.stringContaining("지니"),
      });
    });
    await cleanupModal();
  });

  test("falls back to English generated sample when language phrase is missing", async () => {
    apiStub.listVoiceCatalog.mockImplementation(async () =>
      catalogResponse({
        voices: [
          sampleVoice({
            voiceId: "voice-unknown",
            language: "zz",
            locale: null,
            languageLabel: "ZZ",
          }),
        ],
      }),
    );
    await renderModal();
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="voice-catalog-genie-sample-voice-unknown"] button'),
      ).not.toBeNull();
    });
    const genieBtn = document.querySelector(
      '[data-testid="voice-catalog-genie-sample-voice-unknown"] button',
    ) as HTMLButtonElement;
    expect(genieBtn.disabled).toBe(false);
    expect(genieBtn.title).toBe("No translated Genie sample yet; using English.");
    expect(genieBtn.textContent).toContain("Generate English sample");
    await act(async () => {
      fireEvent.click(genieBtn);
    });
    await waitFor(() => {
      expect(apiStub.previewVoice).toHaveBeenCalledWith("voice-unknown", {
        text: expect.stringContaining("Hi, I'm your Genie"),
      });
    });
    await cleanupModal();
  });
});
