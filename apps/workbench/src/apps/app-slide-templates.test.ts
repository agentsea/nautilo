import { describe, expect, mock, test } from "bun:test";
import { createSlidesTemplateLibrary } from "./app-slide-templates";

const TEMPLATE_A = "10000000-0000-4000-8000-000000000001";
const TEMPLATE_B = "10000000-0000-4000-8000-000000000002";

function client(overrides: Record<string, unknown> = {}) {
  return {
    listSlideTemplates: async () => ({ templates: [], nextCursor: null }),
    readSlideTemplate: async () => ({ content: "<html>slide</html>" }),
    saveSlideTemplate: async () => ({ id: TEMPLATE_A, name: "Launch" }),
    removeSlideTemplate: async () => undefined,
    ...overrides,
  };
}

describe("Slides template host library", () => {
  test("exhausts cursor pages without a collection cap", async () => {
    const listSlideTemplates = mock(async (cursor?: string) => cursor === undefined
      ? { templates: [{ id: TEMPLATE_A, name: "Launch" }], nextCursor: "page-2" }
      : { templates: [{ id: TEMPLATE_B, name: "Close" }], nextCursor: null });
    const library = createSlidesTemplateLibrary({
      client: client({ listSlideTemplates }),
    });

    await expect(library.list()).resolves.toEqual([
      { id: TEMPLATE_A, name: "Launch" },
      { id: TEMPLATE_B, name: "Close" },
    ]);
    expect(listSlideTemplates.mock.calls).toEqual([[undefined], ["page-2"]]);
  });

  test("rejects repeated cursors and duplicate template ids", async () => {
    const repeatedCursor = createSlidesTemplateLibrary({
      client: client({
        listSlideTemplates: async () => ({ templates: [], nextCursor: "same" }),
      }),
    });
    await expect(repeatedCursor.list()).rejects.toThrow("response is invalid");

    let page = 0;
    const duplicate = createSlidesTemplateLibrary({
      client: client({
        listSlideTemplates: async () => page++ === 0
          ? { templates: [{ id: TEMPLATE_A, name: "Launch" }], nextCursor: "next" }
          : { templates: [{ id: TEMPLATE_A, name: "Again" }], nextCursor: null },
      }),
    });
    await expect(duplicate.list()).rejects.toThrow("response is invalid");
  });

  test("fences an in-flight response when the verified host authority changes", async () => {
    let resolvePage!: (page: { templates: never[]; nextCursor: null }) => void;
    const pending = new Promise<{ templates: never[]; nextCursor: null }>((resolve) => {
      resolvePage = resolve;
    });
    let current = true;
    const library = createSlidesTemplateLibrary({
      client: client({ listSlideTemplates: async () => pending }),
      isAuthorityCurrent: () => current,
    });

    const listing = library.list();
    current = false;
    resolvePage({ templates: [], nextCursor: null });
    await expect(listing).rejects.toThrow("authority changed");
  });

  test("validates ids and response shapes around CRUD", async () => {
    const readSlideTemplate = mock(async () => ({ content: "<html>slide</html>" }));
    const removeSlideTemplate = mock(async () => undefined);
    const library = createSlidesTemplateLibrary({
      client: client({ readSlideTemplate, removeSlideTemplate }),
    });

    await expect(library.read(TEMPLATE_A)).resolves.toEqual({ content: "<html>slide</html>" });
    await expect(library.save({ name: "Launch", content: "<html>slide</html>" }))
      .resolves.toEqual({ id: TEMPLATE_A, name: "Launch" });
    await expect(library.remove(TEMPLATE_A)).resolves.toBeUndefined();
    await expect(library.read("not-an-id")).rejects.toThrow("Invalid slide template id");
    expect(readSlideTemplate).toHaveBeenCalledTimes(1);
    expect(removeSlideTemplate).toHaveBeenCalledTimes(1);
  });
});
