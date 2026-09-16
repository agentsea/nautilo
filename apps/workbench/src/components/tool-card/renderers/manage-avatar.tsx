/** D487 — canonical `manage_avatar` photo-library tool card. */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { apiClient } from "../../../lib/api";
import { looksLikeToolError } from "./shared";
import type { ToolRenderer, ToolRendererProps } from "./types";

type AvatarSource = "generate" | "preset";
type GeneratedCandidate = {
  entryId: string;
  thumbnailUrl: string;
  fullUrl: string;
};
type PresetCandidate = { presetId: string };

export type ManageAvatarEnvelope = {
  action: "preview";
  source: AvatarSource;
  selectionRevision: string;
  candidates: Array<GeneratedCandidate | PresetCandidate>;
  prompt?: string;
  model?: string;
  provider?: string;
};

type ImageState =
  | { status: "pending" }
  | { status: "ready"; objectUrl: string }
  | { status: "failed"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCandidate(
  raw: unknown,
  source: AvatarSource,
): GeneratedCandidate | PresetCandidate | null {
  if (!isRecord(raw)) return null;
  if (source === "generate") {
    if (
      typeof raw["entryId"] !== "string" ||
      typeof raw["thumbnailUrl"] !== "string" ||
      typeof raw["fullUrl"] !== "string" ||
      raw["blobId"] !== undefined ||
      raw["presetId"] !== undefined
    )
      return null;
    return {
      entryId: raw["entryId"],
      thumbnailUrl: raw["thumbnailUrl"],
      fullUrl: raw["fullUrl"],
    };
  }
  if (
    typeof raw["presetId"] !== "string" ||
    raw["presetId"].length === 0 ||
    raw["entryId"] !== undefined ||
    raw["blobId"] !== undefined
  )
    return null;
  return { presetId: raw["presetId"] };
}

export function parseEnvelope(
  raw: string | undefined,
): ManageAvatarEnvelope | null {
  if (!raw?.trim()) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!isRecord(obj) || obj["action"] !== "preview") return null;
    if (obj["source"] !== "generate" && obj["source"] !== "preset") return null;
    if (
      typeof obj["selectionRevision"] !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(obj["selectionRevision"])
    )
      return null;
    if (!Array.isArray(obj["candidates"])) return null;
    const source = obj["source"];
    const candidates: ManageAvatarEnvelope["candidates"] = [];
    for (const row of obj["candidates"]) {
      const candidate = parseCandidate(row, source);
      if (!candidate) return null;
      candidates.push(candidate);
    }
    if (obj["prompt"] !== undefined && typeof obj["prompt"] !== "string")
      return null;
    if (obj["model"] !== undefined && typeof obj["model"] !== "string")
      return null;
    if (obj["provider"] !== undefined && typeof obj["provider"] !== "string")
      return null;
    return {
      action: "preview",
      source,
      selectionRevision: obj["selectionRevision"],
      candidates,
      ...(obj["prompt"] !== undefined ? { prompt: obj["prompt"] } : {}),
      ...(obj["model"] !== undefined ? { model: obj["model"] } : {}),
      ...(obj["provider"] !== undefined ? { provider: obj["provider"] } : {}),
    };
  } catch {
    return null;
  }
}

export function formatCollapsedSummary(resultText: string | undefined): string {
  const env = parseEnvelope(resultText);
  if (!env) return "manage_avatar";
  const n = env.candidates.length;
  if (env.source === "preset") {
    const first = env.candidates[0];
    return first && "presetId" in first
      ? `Avatar · preset ${first.presetId}`
      : "Avatar · preset";
  }
  return `Avatar · ${n} candidate${n === 1 ? "" : "s"}`;
}

function useOwnedPhoto(entryId: string): {
  state: ImageState;
  retry: () => void;
} {
  const [state, setState] = useState<ImageState>({ status: "pending" });
  const generationRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);

  const release = useCallback(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);
  const load = useCallback(() => {
    const generation = ++generationRef.current;
    release();
    setState({ status: "pending" });
    void apiClient
      .getAgentPhotoLibraryMedia(entryId, "thumb")
      .then(({ blob }) => {
        if (generationRef.current !== generation) return;
        const objectUrl = URL.createObjectURL(blob);
        objectUrlRef.current = objectUrl;
        setState({ status: "ready", objectUrl });
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : "Preview failed",
        });
      });
  }, [entryId, release]);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
      release();
    };
  }, [load, release]);
  return { state, retry: load };
}

function GeneratedThumbnail({ entryId }: { entryId: string }): ReactElement {
  const { state, retry } = useOwnedPhoto(entryId);
  if (state.status === "pending") {
    return (
      <div className="flex aspect-square items-center justify-center rounded bg-muted text-[0.65rem] text-foreground-dim">
        Loading…
      </div>
    );
  }
  if (state.status === "ready") {
    return (
      <img
        src={state.objectUrl}
        alt="Generated Agent photo candidate"
        className="aspect-square w-full rounded object-cover"
        data-testid={`manage-avatar-preview-${entryId}`}
      />
    );
  }
  return (
    <div className="flex aspect-square flex-col items-center justify-center gap-1 rounded bg-muted px-2 text-center">
      <span className="text-[0.65rem] text-tool-error">{state.message}</span>
      <button
        type="button"
        className="rounded border border-border px-1.5 py-0.5 text-[0.65rem] hover:bg-background"
        onClick={(event) => {
          event.stopPropagation();
          retry();
        }}
      >
        Retry
      </button>
    </div>
  );
}

function presetImageUrl(presetId: string): string {
  return `/api/onboarding/images/avatars/${encodeURIComponent(presetId)}.webp`;
}

function candidateKey(candidate: GeneratedCandidate | PresetCandidate): string {
  return "entryId" in candidate ? candidate.entryId : candidate.presetId;
}

export function buildPhotoSelectionRequest(
  candidate: GeneratedCandidate | PresetCandidate,
  expectedSelectionRevision: string,
) {
  return {
    input: {
      target:
        "entryId" in candidate
          ? { kind: "entry" as const, entryId: candidate.entryId }
          : { kind: "preset" as const, presetId: candidate.presetId },
      expectedSelectionRevision,
    },
    options: {
      idempotencyKey: crypto.randomUUID(),
      origin: "manage_avatar" as const,
    },
  };
}

function CandidateCard({
  candidate,
  selected,
  onSelect,
  groupName,
}: {
  candidate: GeneratedCandidate | PresetCandidate;
  selected: boolean;
  onSelect: () => void;
  groupName: string;
}): ReactElement {
  const id = useId();
  const key = candidateKey(candidate);
  return (
    <label
      htmlFor={id}
      className="cursor-pointer rounded border border-border p-2 has-[:checked]:border-accent"
      data-testid={`manage-avatar-candidate-${key}`}
    >
      <div className="space-y-2">
        {"entryId" in candidate ? (
          <GeneratedThumbnail entryId={candidate.entryId} />
        ) : (
          <img
            src={presetImageUrl(candidate.presetId)}
            alt={`Preset Agent photo ${candidate.presetId}`}
            className="aspect-square w-full rounded object-cover"
          />
        )}
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="radio"
            name={groupName}
            checked={selected}
            onChange={onSelect}
          />
          <span className="truncate text-[0.65rem] text-foreground-dim">
            {key}
          </span>
        </div>
      </div>
    </label>
  );
}

function ManageAvatarExpanded({
  resultText,
  state,
  event,
}: ToolRendererProps): ReactElement {
  const toolError = looksLikeToolError(resultText) ? resultText : undefined;
  const env = toolError ? null : parseEnvelope(resultText);
  const groupName = useId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [locking, setLocking] = useState(false);

  if (toolError)
    return (
      <div className="border-t border-border px-3 py-2">
        <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
          Tool error
        </div>
        <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">
          {toolError}
        </pre>
      </div>
    );
  if (!env)
    return (
      <div className="border-t border-border px-3 py-2">
        {resultText && (
          <pre className="whitespace-pre-wrap break-words text-xs">
            {resultText}
          </pre>
        )}
        {state === "error" && event?.error && (
          <pre className="text-xs text-tool-error whitespace-pre-wrap">
            {event.error}
          </pre>
        )}
      </div>
    );

  const effectiveSelected =
    selectedKey &&
    env.candidates.some((candidate) => candidateKey(candidate) === selectedKey)
      ? selectedKey
      : env.candidates[0]
        ? candidateKey(env.candidates[0])
        : null;
  const selected = env.candidates.find(
    (candidate) => candidateKey(candidate) === effectiveSelected,
  );

  const handleSetAvatar = async () => {
    if (!selected) return;
    setLockError(null);
    setLocking(true);
    try {
      const request = buildPhotoSelectionRequest(
        selected,
        env.selectionRevision,
      );
      await apiClient.selectAgentPhotoLibraryEntry(
        request.input,
        request.options,
      );
      setConfirmed(true);
    } catch (error) {
      setLockError(
        error instanceof Error ? error.message : "Agent photo update failed",
      );
    } finally {
      setLocking(false);
    }
  };

  if (confirmed)
    return (
      <div
        className="border-t border-border px-3 py-2"
        data-testid="manage-avatar-confirmed"
      >
        <p className="text-xs text-foreground">✓ Agent photo updated.</p>
      </div>
    );
  return (
    <div
      className="border-t border-border px-3 py-2 space-y-3"
      data-testid="manage-avatar-expanded"
      onClick={(event) => event.stopPropagation()}
    >
      <div>
        <div className="text-xs font-medium text-foreground">
          Pick an Agent photo
        </div>
        {env.source === "generate" && (
          <p className="text-[0.65rem] text-foreground-dim">
            {env.candidates.length} generated candidate
            {env.candidates.length === 1 ? "" : "s"}
            {env.model ? ` · ${env.model}` : ""}
            {env.provider ? ` · ${env.provider}` : ""}
          </p>
        )}
      </div>
      {env.candidates.length > 0 && (
        <section
          aria-label="Agent photo candidates"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {env.candidates.map((candidate) => {
            const key = candidateKey(candidate);
            return (
              <CandidateCard
                key={key}
                candidate={candidate}
                groupName={groupName}
                selected={effectiveSelected === key}
                onSelect={() => setSelectedKey(key)}
              />
            );
          })}
        </section>
      )}
      {env.candidates.length > 0 && (
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            className="rounded border border-border bg-muted px-2 py-1 text-xs hover:bg-muted/80 disabled:opacity-50"
            data-testid="manage-avatar-set"
            disabled={locking || !effectiveSelected}
            onClick={() => void handleSetAvatar()}
          >
            {locking ? "Setting photo…" : "Set as my photo"}
          </button>
          {lockError && (
            <p
              className="text-xs text-tool-error"
              data-testid="manage-avatar-lock-error"
            >
              {lockError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export const manageAvatarRenderer: ToolRenderer = {
  collapsedSummary: ({ resultText }) => formatCollapsedSummary(resultText),
  autoExpandOnResult: true,
  ExpandedBody: ManageAvatarExpanded,
};
