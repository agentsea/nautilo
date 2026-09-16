import { apiClient } from "../lib/api";

export interface AppSlideTemplateSummary {
  id: string;
  name: string;
}

export interface AppSlideTemplateLibrary {
  list(): Promise<AppSlideTemplateSummary[]>;
  read(id: string): Promise<{ content: string }>;
  save(input: { name: string; content: string }): Promise<AppSlideTemplateSummary>;
  remove(id: string): Promise<void>;
}

type SlideTemplateApi = Pick<
  typeof apiClient,
  "listSlideTemplates" | "readSlideTemplate" | "saveSlideTemplate" | "removeSlideTemplate"
>;

export interface SlidesTemplateLibraryOptions {
  client?: SlideTemplateApi;
  /** True only while the verified Human/server binding captured by the host
   * frame still matches. Checked across every async response boundary. */
  isAuthorityCurrent?: () => boolean;
}

const TEMPLATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function summary(value: unknown): AppSlideTemplateSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "id" && key !== "name") ||
    typeof record["id"] !== "string" ||
    !TEMPLATE_ID.test(record["id"]) ||
    typeof record["name"] !== "string" ||
    record["name"].normalize("NFC").trim() !== record["name"] ||
    record["name"].length === 0
  ) return null;
  return { id: record["id"], name: record["name"] };
}

function requireTemplateId(id: string): void {
  if (!TEMPLATE_ID.test(id)) throw new TypeError("Invalid slide template id.");
}

export function createSlidesTemplateLibrary(
  options: SlidesTemplateLibraryOptions = {},
): AppSlideTemplateLibrary {
  const client = options.client ?? apiClient;
  const assertAuthorityCurrent = (): void => {
    if (options.isAuthorityCurrent?.() === false) {
      throw new Error("Slide template authority changed.");
    }
  };
  return Object.freeze({
    async list(): Promise<AppSlideTemplateSummary[]> {
      const templates: AppSlideTemplateSummary[] = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        assertAuthorityCurrent();
        const page: unknown = await client.listSlideTemplates(cursor);
        assertAuthorityCurrent();
        if (!page || typeof page !== "object" || Array.isArray(page)) {
          throw new Error("Slide template list response is invalid.");
        }
        const record = page as Record<string, unknown>;
        if (
          Object.keys(record).some((key) => key !== "templates" && key !== "nextCursor") ||
          !Array.isArray(record["templates"]) ||
          (record["nextCursor"] !== null && typeof record["nextCursor"] !== "string")
        ) throw new Error("Slide template list response is invalid.");
        for (const item of record["templates"]) {
          const parsed = summary(item);
          if (!parsed || ids.has(parsed.id)) {
            throw new Error("Slide template list response is invalid.");
          }
          ids.add(parsed.id);
          templates.push(parsed);
        }
        const next = record["nextCursor"];
        if (next === null) {
          cursor = undefined;
        } else {
          if (next.length === 0 || cursors.has(next)) {
            throw new Error("Slide template list response is invalid.");
          }
          cursors.add(next);
          cursor = next;
        }
      } while (cursor !== undefined);
      return templates;
    },

    async read(id: string): Promise<{ content: string }> {
      requireTemplateId(id);
      assertAuthorityCurrent();
      const response: unknown = await client.readSlideTemplate(id);
      assertAuthorityCurrent();
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new Error("Slide template response is invalid.");
      }
      const record = response as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || typeof record["content"] !== "string") {
        throw new Error("Slide template response is invalid.");
      }
      return { content: record["content"] };
    },

    async save(input: { name: string; content: string }): Promise<AppSlideTemplateSummary> {
      assertAuthorityCurrent();
      const response: unknown = await client.saveSlideTemplate(input);
      assertAuthorityCurrent();
      const parsed = summary(response);
      if (!parsed) throw new Error("Slide template save response is invalid.");
      return parsed;
    },

    async remove(id: string): Promise<void> {
      requireTemplateId(id);
      assertAuthorityCurrent();
      await client.removeSlideTemplate(id);
      assertAuthorityCurrent();
    },
  });
}
