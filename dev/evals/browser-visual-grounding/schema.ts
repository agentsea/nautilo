export const BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION = 1 as const;

export interface CorpusIndex {
  readonly schemaVersion: typeof BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION;
  readonly cases: ReadonlyArray<{ readonly id: string }>;
}

export interface CaptureArtifact {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BrowserVisualGroundingCase {
  readonly schemaVersion: typeof BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION;
  readonly id: string;
  readonly description: string;
  readonly sourceUrl: string;
  readonly capturedAt: string;
  readonly captureDurationMs: number;
  readonly evidencePairWindowMs: number;
  readonly agentBrowserVersion: string;
  readonly viewport: {
    readonly css: { readonly width: number; readonly height: number };
    readonly image: { readonly width: number; readonly height: number };
    readonly dpr: number;
    readonly imageToCssScale: number;
  };
  readonly refs: Record<string, { readonly role: string; readonly name: string }>;
  readonly snapshot: CaptureArtifact;
  readonly screenshot: CaptureArtifact;
}

export const isCaseId = (value: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

export function parseCorpusIndex(value: unknown): CorpusIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Corpus index must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate["schemaVersion"] !== BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION
    || !Array.isArray(candidate["cases"])) throw new Error("Invalid corpus index");
  const ids = candidate["cases"].map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid corpus case entry");
    }
    const id = (entry as Record<string, unknown>)["id"];
    if (typeof id !== "string" || !isCaseId(id)) throw new Error("Invalid corpus case entry");
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate corpus case id");
  if ([...ids].sort().some((id, index) => id !== ids[index])) throw new Error("Corpus cases must be sorted by id");
  return { schemaVersion: BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION, cases: ids.map((id) => ({ id })) };
}
