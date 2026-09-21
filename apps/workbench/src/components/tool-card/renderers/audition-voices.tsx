/**
 * `audition_voices` tool card (Model 2).
 *
 * The tool envelope is metadata-only; this card owns preview audio via
 * `apiClient.previewVoice` per slate row. Lock-in uses
 * `apiClient.upsertVoiceAssignment` and does not require a preview.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import type {
  AuditionVoicesToolResult,
  VoiceDiscoveryBadge,
  VoiceDiscoveryCandidate,
} from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { looksLikeToolError } from "./shared";
import { genieSampleTextForLanguage } from "../../voice-catalog/voice-catalog-modal";

type PreviewState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "ready"; objectUrl: string }
  | { status: "failed" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function isBadge(v: unknown): v is VoiceDiscoveryBadge {
  return v === "curated" || v === "provider_v3" || v === "provider_verified" || v === "unverified";
}

function parseCandidate(raw: unknown): VoiceDiscoveryCandidate | null {
  if (!isRecord(raw)) return null;
  if (typeof raw["voiceId"] !== "string" || raw["voiceId"].length === 0) return null;
  if (typeof raw["name"] !== "string") return null;
  if (typeof raw["language"] !== "string") return null;
  if (typeof raw["languageLabel"] !== "string") return null;
  if (typeof raw["accent"] !== "string") return null;
  if (typeof raw["gender"] !== "string") return null;
  if (typeof raw["age"] !== "string") return null;
  if (!isBadge(raw["badge"])) return null;
  if (typeof raw["matchReason"] !== "string") return null;
  if (!Array.isArray(raw["verifiedLanguages"])) return null;
  const honestyWarning = raw["honestyWarning"];
  if (honestyWarning !== undefined && typeof honestyWarning !== "string") return null;
  return raw as VoiceDiscoveryCandidate;
}

/** Parse the  audition_voices JSON envelope; null on malformed. */
export function parseEnvelope(raw: string | undefined): AuditionVoicesToolResult | null {
  if (!raw?.trim()) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!isRecord(obj)) return null;
    if (!Array.isArray(obj["slate"])) return null;
    if (typeof obj["consideredCount"] !== "number" || !Number.isFinite(obj["consideredCount"])) {
      return null;
    }
    const slate: VoiceDiscoveryCandidate[] = [];
    for (const row of obj["slate"] as unknown[]) {
      const c = parseCandidate(row);
      if (!c) return null;
      slate.push(c);
    }
    if (obj["suggestedSlate"] !== undefined && typeof obj["suggestedSlate"] !== "boolean") {
      return null;
    }
    if (obj["role"] !== undefined && typeof obj["role"] !== "string") return null;
    if (obj["sampleText"] !== undefined && typeof obj["sampleText"] !== "string") return null;
    if (obj["warnings"] !== undefined) {
      if (!Array.isArray(obj["warnings"]) || obj["warnings"].some((w) => typeof w !== "string")) {
        return null;
      }
    }
    if (obj["error"] !== undefined && typeof obj["error"] !== "string") return null;
    return {
      slate,
      consideredCount: obj["consideredCount"],
      ...(obj["suggestedSlate"] !== undefined ?
        { suggestedSlate: obj["suggestedSlate"] }
      : {}),
      ...(obj["role"] !== undefined ? { role: obj["role"] } : {}),
      ...(obj["sampleText"] !== undefined ? { sampleText: obj["sampleText"] } : {}),
      ...(obj["warnings"] !== undefined ?
        { warnings: obj["warnings"] as string[] }
      : {}),
      ...(obj["error"] !== undefined ? { error: obj["error"] } : {}),
    };
  } catch {
    return null;
  }
}

function formatDiscoveryBadge(badge: VoiceDiscoveryBadge): string {
  switch (badge) {
    case "curated":
      return "★ curated/tested";
    case "provider_v3":
    case "provider_verified":
      return "✓ provider reference";
    case "unverified":
      return "⚠ unverified reference";
  }
}

export function formatCollapsedSummary(resultText: string | undefined): string {
  const env = parseEnvelope(resultText);
  if (!env) return "audition_voices";
  const n = env.slate.length;
  const rolePart = env.role ? ` · ${env.role}` : "";
  return `Audition voices · ${n} candidate${n === 1 ? "" : "s"}${rolePart}`;
}

function roleLockInButtonText(role: string | undefined): {
  text: string;
  disabled: boolean;
  note?: string;
} {
  const trimmed = role?.trim();
  if (!trimmed) {
    return {
      text: "Lock in selected voice",
      disabled: true,
      note: "Role missing — cannot assign until the tool provides default or a language code.",
    };
  }
  return { text: `Lock in selected for ${trimmed}`, disabled: false };
}

function roleConfirmedMessage(
  name: string,
  role: string | undefined,
  languageLabel?: string,
): string {
  if (role === "default") return `✓ ${name} is now Genie's primary voice.`;
  if (role?.trim()) {
    const label = languageLabel ? `${languageLabel} (${role})` : role;
    return `✓ ${name} is now Genie's ${label} voice.`;
  }
  return `✓ ${name} is locked in.`;
}

function candidateMetaLine(c: VoiceDiscoveryCandidate): string {
  const parts = [c.accent];
  if (c.gender) parts.push(c.gender);
  if (c.age) parts.push(c.age);
  return parts.filter(Boolean).join(" · ");
}

function candidateProviderPreviewUrl(candidate: VoiceDiscoveryCandidate): string | null {
  return (
    candidate.previewUrl ??
    candidate.verifiedLanguages.find((entry) => typeof entry.previewUrl === "string" && entry.previewUrl.length > 0)?.previewUrl ??
    null
  );
}

function useVoicePreview(voiceId: string, sampleText: string, fallbackPreviewUrl: string | null): {
  state: PreviewState;
  load: () => void;
} {
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const objectUrlRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const revoke = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const load = useCallback(() => {
    const gen = ++generationRef.current;
    revoke();
    setState({ status: "pending" });
    void apiClient
      .previewVoice(voiceId, { text: sampleText })
      .then((blob) => {
        if (generationRef.current !== gen) return;
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setState({ status: "ready", objectUrl: url });
      })
      .catch(() => {
        if (generationRef.current !== gen) return;
        if (fallbackPreviewUrl) {
          setState({ status: "ready", objectUrl: fallbackPreviewUrl });
          return;
        }
        setState({ status: "failed" });
      });
  }, [fallbackPreviewUrl, voiceId, sampleText, revoke]);

  useEffect(
    () => {
      generationRef.current += 1;
      revoke();
      setState({ status: "idle" });
      return () => {
        generationRef.current += 1;
        revoke();
      };
    },
    [fallbackPreviewUrl, revoke, sampleText, voiceId],
  );

  return { state, load };
}

function PreviewControl({
  voiceId,
  state,
  onLoad,
}: {
  voiceId: string;
  state: PreviewState;
  onLoad: () => void;
}): ReactElement {
  if (state.status === "idle") {
    return (
      <button
        type="button"
        className="rounded border border-border px-1.5 py-0.5 text-[0.65rem] hover:bg-muted"
        data-testid={`audition-voices-preview-load-${voiceId}`}
        onClick={(e) => {
          e.stopPropagation();
          onLoad();
        }}
      >
        Load voice sample
      </button>
    );
  }
  if (state.status === "pending") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-foreground-dim"
        data-testid={`audition-voices-preview-pending-${voiceId}`}
        aria-live="polite"
      >
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-accent" />
        Loading voice sample…
      </span>
    );
  }
  if (state.status === "ready") {
    return (
      <audio
        controls
        preload="none"
        src={state.objectUrl}
        className="h-7 max-w-[10rem]"
        data-testid={`audition-voices-preview-ready-${voiceId}`}
      />
    );
  }
  return (
    <span
      className="flex items-center gap-1 text-xs"
      data-testid={`audition-voices-preview-failed-${voiceId}`}
      aria-live="polite"
    >
      <span className="text-[var(--warning,#b58900)]">preview failed</span>
      <button
        type="button"
        className="rounded border border-border px-1.5 py-0.5 text-[0.65rem] hover:bg-muted"
        data-testid={`audition-voices-preview-retry-${voiceId}`}
        onClick={(e) => {
          e.stopPropagation();
          onLoad();
        }}
      >
        Retry
      </button>
    </span>
  );
}

function SlateCandidateRow({
  candidate,
  selected,
  onSelect,
  groupName,
  toolSampleText,
}: {
  candidate: VoiceDiscoveryCandidate;
  selected: boolean;
  onSelect: () => void;
  groupName: string;
  toolSampleText: string | undefined;
}): ReactElement {
  const sampleText = toolSampleText?.trim() || genieSampleTextForLanguage(candidate.language);
  const { state, load } = useVoicePreview(
    candidate.voiceId,
    sampleText,
    candidateProviderPreviewUrl(candidate),
  );
  const rowId = useId();

  return (
    <label
      htmlFor={rowId}
      className="flex cursor-pointer flex-col gap-1 rounded border border-border px-2 py-1.5 has-[:checked]:border-accent"
      data-testid={`audition-voices-row-${candidate.voiceId}`}
    >
      <div className="flex items-start gap-2">
        <input
          id={rowId}
          type="radio"
          name={groupName}
          checked={selected}
          className="mt-1"
          onChange={onSelect}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-foreground">{candidate.name}</span>
            <PreviewControl voiceId={candidate.voiceId} state={state} onLoad={load} />
          </div>
          <div className="text-[0.65rem] text-foreground-dim">
            <span>{formatDiscoveryBadge(candidate.badge)}</span>
            <span className="mx-1">·</span>
            <span>{candidateMetaLine(candidate)}</span>
          </div>
          <p className="text-[0.65rem] text-foreground-muted">{candidate.matchReason}</p>
          {candidate.honestyWarning && (
            <p className="text-[0.65rem] text-[var(--warning,#b58900)]">{candidate.honestyWarning}</p>
          )}
        </div>
      </div>
    </label>
  );
}

type ConfirmedState = {
  name: string;
  voiceId: string;
  role: string;
  language?: string;
  languageLabel?: string;
  sampleText?: string;
  previewUrl: string | null;
};

function ConfirmedBody({ confirmed }: { confirmed: ConfirmedState }): ReactElement {
  const { state, load } = useVoicePreview(
    confirmed.voiceId,
    confirmed.sampleText?.trim() || genieSampleTextForLanguage(confirmed.language ?? "en"),
    confirmed.previewUrl,
  );

  return (
    <div
      className="border-t border-border px-3 py-2 space-y-2"
      data-testid="audition-voices-confirmed"
    >
      <p className="text-xs text-foreground">
        {roleConfirmedMessage(confirmed.name, confirmed.role, confirmed.languageLabel)}
      </p>
      <PreviewControl voiceId={confirmed.voiceId} state={state} onLoad={load} />
    </div>
  );
}

function AuditionVoicesExpanded(props: ToolRendererProps): ReactElement {
  const { resultText, state, event } = props;
  const toolError = looksLikeToolError(resultText) ? resultText : undefined;
  const env = toolError ? null : parseEnvelope(resultText);
  const radioGroup = useId();

  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedState | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [locking, setLocking] = useState(false);

  const slate = env?.slate ?? [];
  const effectiveSelected =
    selectedVoiceId && slate.some((c) => c.voiceId === selectedVoiceId) ?
      selectedVoiceId
    : (slate[0]?.voiceId ?? null);

  const lockIn = roleLockInButtonText(env?.role);

  const handleLockIn = async () => {
    if (!env?.role?.trim() || !effectiveSelected) return;
    const candidate = slate.find((c) => c.voiceId === effectiveSelected);
    if (!candidate) return;
    setLockError(null);
    setLocking(true);
    try {
      await apiClient.upsertVoiceAssignment(env.role.trim(), {
        voiceId: candidate.voiceId,
        voiceName: candidate.name,
      });
      setConfirmed({
        name: candidate.name,
        voiceId: candidate.voiceId,
        role: env.role.trim(),
        language: candidate.language,
        languageLabel: candidate.languageLabel,
        sampleText: env.sampleText,
        previewUrl: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Lock-in failed";
      setLockError(msg);
    } finally {
      setLocking(false);
    }
  };

  if (toolError) {
    return (
      <div className="border-t border-border px-3 py-2">
        <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
          Tool error
        </div>
        <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">{toolError}</pre>
      </div>
    );
  }

  if (!env) {
    return (
      <div className="border-t border-border px-3 py-2">
        {resultText && <pre className="whitespace-pre-wrap break-words text-xs">{resultText}</pre>}
        {state === "error" && event?.error && (
          <pre className="text-xs text-tool-error whitespace-pre-wrap">{event.error}</pre>
        )}
      </div>
    );
  }

  if (confirmed) {
    return <ConfirmedBody confirmed={confirmed} />;
  }

  const languageLabel = slate[0]?.languageLabel;
  const title =
    languageLabel ?
      `Pick a ${languageLabel} voice`
    : env.role && env.role !== "default" ?
      `Pick a voice (${env.role})`
    : "Audition voices";

  return (
    <div className="border-t border-border px-3 py-2 space-y-3" data-testid="audition-voices-expanded">
      <div>
        <div className="text-xs font-medium text-foreground">{title}</div>
        {env.suggestedSlate && (
          <p className="text-[0.65rem] text-foreground-dim">Suggested slate from discovery ranking.</p>
        )}
        <p className="text-[0.65rem] text-foreground-dim">
          Considered {env.consideredCount} voice{env.consideredCount === 1 ? "" : "s"} in catalog.
        </p>
      </div>

      {env.warnings?.map((w, i) => (
        <p key={i} className="text-xs text-[var(--warning,#b58900)]">
          {w}
        </p>
      ))}
      {env.error && (
        <p className="text-xs text-tool-error" data-testid="audition-voices-envelope-error">
          {env.error}
        </p>
      )}

      {slate.length > 0 ?
        <section aria-label="audition slate" className="space-y-2">
          {slate.map((c) => (
            <SlateCandidateRow
              key={c.voiceId}
              candidate={c}
              groupName={radioGroup}
              toolSampleText={env.sampleText}
              selected={effectiveSelected === c.voiceId}
              onSelect={() => setSelectedVoiceId(c.voiceId)}
            />
          ))}
        </section>
      : null}

      {slate.length > 0 && (
        <div className="flex flex-col items-end gap-1">
          {lockIn.note && (
            <p className="text-[0.65rem] text-foreground-dim text-right max-w-full">{lockIn.note}</p>
          )}
          <button
            type="button"
            className="rounded border border-border bg-muted px-2 py-1 text-xs hover:bg-muted/80 disabled:opacity-50"
            data-testid="audition-voices-lock-in"
            disabled={lockIn.disabled || locking || !effectiveSelected}
            onClick={() => void handleLockIn()}
          >
            {locking ? "Locking in…" : lockIn.text}
          </button>
          {lockError && (
            <p className="text-xs text-tool-error" data-testid="audition-voices-lock-error">
              {lockError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function collapsedSummary(input: {
  resultText: string | undefined;
}): string {
  return formatCollapsedSummary(input.resultText);
}

export const auditionVoicesRenderer: ToolRenderer = {
  collapsedSummary,
  autoExpandOnResult: true,
  ExpandedBody: AuditionVoicesExpanded,
};
