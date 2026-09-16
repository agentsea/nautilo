import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type AssistantModelSummary, ApiError } from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { isSelectableModel, mergeModelRows } from "../../../lib/model-availability";
import { useProfile } from "../../../hooks/use-profile";
import { useCan } from "../../../hooks/use-can";
import {
  Button,
  FieldRow,
  GuestPlaceholder,
  SectionCard,
  StatusPill,
} from "../ui";
import { formatProviderGroupLabel, providerFromModelId } from "./model-browser-helpers";

type SaveState = "idle" | "saving" | "saved" | { error: string };

/**
 * D370 — a sensible curated default fallback chain. A provider-diverse set so a
 * single-provider outage still has a path. Rendered filtered to models actually
 * selectable in this deployment; applying it fills the draft chain but does NOT
 * flip the Enable toggle (opt-in is preserved — the user still consents).
 */
const RECOMMENDED_FALLBACK_CHAIN: readonly string[] = [
  "anthropic:claude-sonnet-4-6",
  "openai:gpt-5.4-2026-03-05",
  "google:gemini-2.5-pro",
];

function chainsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function isLimitedAvailability(m: AssistantModelSummary): boolean {
  return (m as { availability?: string }).availability === "limited";
}

export function FallbackSection() {
  const { response } = useProfile();
  const can = useCan();
  const canReadServerModels = can("read_server_settings");
  const profile = response?.viewerRole === "owner" ? response.agent : null;
  // M129 — per-user fallback is PERSONAL config (owner's decision): gate
  // on owning THIS Agent (per-agent `viewerRole === "owner"`), not the
  // server-wide owner Role. Any user editing their own Agent's fallback
  // chain may do so (AR-5 self-edit), not just a server-wide owner.
  const enabled = response?.viewerRole === "owner";

  const [models, setModels] = useState<AssistantModelSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentEnabled, setCurrentEnabled] = useState(false);
  const [currentChain, setCurrentChain] = useState<string[]>([]);
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [draftChain, setDraftChain] = useState<string[]>([]);
  const [addPick, setAddPick] = useState("");
  const [save, setSave] = useState<SaveState>("idle");
  const draftDirtyRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      draftDirtyRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      setLoadError(null);
      try {
        const retainedIds = profile?.fallback?.chain ?? [];
        const [raw, retained] = await Promise.all([
          apiClient.getModels(),
          retainedIds.length > 0
            ? apiClient.resolveRetainedModels(retainedIds)
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setModels(mergeModelRows(raw.filter(isSelectableModel), retained));
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Failed to load models");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, profile?.fallback?.chain]);

  useEffect(() => {
    if (!enabled || !profile) return;
    const fb = profile.fallback ?? { enabled: false, chain: [] };
    setCurrentEnabled(fb.enabled);
    setCurrentChain([...fb.chain]);
    if (!draftDirtyRef.current) {
      setDraftEnabled(fb.enabled);
      setDraftChain([...fb.chain]);
    }
  }, [enabled, profile]);

  const catalogById = useMemo(() => {
    const map = new Map<string, AssistantModelSummary>();
    if (models) {
      for (const m of models) map.set(m.id, m);
    }
    return map;
  }, [models]);

  const addCandidates = useMemo(() => {
    if (!models) return [];
    const inChain = new Set(draftChain);
    return models.filter(
      (m) => isSelectableModel(m) && !inChain.has(m.id) && !isLimitedAvailability(m),
    );
  }, [models, draftChain]);

  const resolvedAddId = useMemo(() => {
    if (addPick && addCandidates.some((m) => m.id === addPick)) return addPick;
    return addCandidates[0]?.id ?? "";
  }, [addPick, addCandidates]);

  const distinctProvidersInDraft = useMemo(() => {
    const set = new Set<string>();
    for (const id of draftChain) {
      set.add(providerFromModelId(id));
    }
    return set;
  }, [draftChain]);
  const showCrossProviderNote = distinctProvidersInDraft.size >= 2;

  const canSave =
    draftEnabled !== currentEnabled || !chainsEqual(draftChain, currentChain);

  const markDirty = () => {
    draftDirtyRef.current = true;
    if (save !== "idle") setSave("idle");
  };

  const handleSave = async () => {
    if (!canSave) {
      setSave("saved");
      return;
    }
    setSave("saving");
    try {
      const result = await apiClient.updateFallbackPolicy({
        enabled: draftEnabled,
        chain: draftChain,
      });
      setCurrentEnabled(result.enabled);
      setCurrentChain([...result.chain]);
      setDraftEnabled(result.enabled);
      setDraftChain([...result.chain]);
      draftDirtyRef.current = false;
      setSave("saved");
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Save failed";
      setSave({ error: message });
    }
  };

  const moveInChain = (index: number, delta: -1 | 1) => {
    markDirty();
    setDraftChain((prev) => {
      const j = index + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const a = next[index];
      const b = next[j];
      if (a === undefined || b === undefined) return prev;
      next[index] = b;
      next[j] = a;
      return next;
    });
  };

  const removeAt = (index: number) => {
    markDirty();
    setDraftChain((prev) => prev.filter((_, i) => i !== index));
  };

  const appendPick = () => {
    if (!resolvedAddId) return;
    markDirty();
    setDraftChain((prev) => [...prev, resolvedAddId]);
  };

  // D370 — recommended chain, filtered to models actually selectable here.
  const recommendedAvailable = useMemo(
    () => RECOMMENDED_FALLBACK_CHAIN.filter((id) => {
      const model = catalogById.get(id);
      return model !== undefined && isSelectableModel(model);
    }),
    [catalogById],
  );
  const canApplyRecommended =
    recommendedAvailable.length > 0 && !chainsEqual(draftChain, recommendedAvailable);
  const applyRecommended = () => {
    if (recommendedAvailable.length === 0) return;
    markDirty();
    // Fill the chain only — leave draftEnabled untouched so opt-in is explicit.
    setDraftChain([...recommendedAvailable]);
  };

  if (!enabled) {
    return (
      <SectionCard
        id="fallback"
        title="Model fallback (per-Agent)"
        description="Only this Agent's fallback policy. Your selected model is always tried first; if it fails, Nautilo tries these next, in order. Off by default."
      >
        <GuestPlaceholder what="Model fallback policy" />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="fallback"
      title="Model fallback (per-Agent)"
      description="Only this Agent's fallback policy. Your selected model is always tried first; if it fails, Nautilo tries these next, in order. Off by default."
    >
      {loadError ? (
        <p className="text-sm text-[var(--error)]">{loadError}</p>
      ) : !models ? (
        <p className="text-sm text-foreground-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <p className="rounded-md border border-border/60 bg-background-panel/50 px-3 py-2 text-xs text-foreground-muted">
            This fallback chain is used only for this Agent and does not change
            the server-wide fallback baseline.
            {canReadServerModels ? (
              <>
                {" "}
                <Link to="/admin#models" className="font-medium text-foreground underline">
                  Manage the server-wide baseline in Server Admin.
                </Link>
              </>
            ) : null}
          </p>
          <FieldRow label="Enable model fallback" hint="When disabled, the chain is stored but not used at runtime.">
            <button
              type="button"
              data-testid="fallback-toggle"
              aria-pressed={draftEnabled}
              onClick={() => {
                markDirty();
                setDraftEnabled((v) => !v);
              }}
              className={[
                "rounded-lg border p-3 text-left text-sm font-medium transition-colors",
                draftEnabled
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background-panel/40 text-foreground-muted hover:bg-background-element/70",
              ].join(" ")}
            >
              <span className="block">{draftEnabled ? "On" : "Off"}</span>
              <span className="mt-1 block text-xs font-normal text-foreground-muted">
                Fallback runs only while enabled; you can still edit the chain while off.
              </span>
            </button>
          </FieldRow>

          <div
            className={[!draftEnabled ? "opacity-60" : "", "space-y-3"].filter(Boolean).join(" ")}
            {...(!draftEnabled ? { "aria-disabled": true as const } : {})}
          >
            <FieldRow
              label="Fallback order"
              hint="Your selected model is attempt #1; these are tried next, top-to-bottom, after a recoverable failure. You don't need to add your selected model here."
            >
              <div className="space-y-3">
                {recommendedAvailable.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => applyRecommended()}
                      disabled={!canApplyRecommended}
                    >
                      Use recommended chain
                    </Button>
                    <span className="text-xs text-foreground-muted">
                      Fills the order below; you still turn fallback on above.
                    </span>
                  </div>
                ) : null}

                <ul className="divide-y divide-border/60 rounded-lg border border-border bg-background-panel/50">
                  {draftChain.length === 0 ? (
                    <li className="px-3 py-4 text-sm text-foreground-muted">
                      No fallback models yet. Use the recommended chain, or add models below.
                    </li>
                  ) : (
                    draftChain.map((id, index) => {
                      const m = catalogById.get(id);
                      const display = m?.displayName ?? id;
                      const provider = providerFromModelId(id);
                      const moveUpLabel = `Move ${display} up`;
                      const moveDownLabel = `Move ${display} down`;
                      const removeLabel = `Remove ${display}`;
                      return (
                        <li
                          key={`${id}-${index}`}
                          className="flex flex-wrap items-center gap-2 px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium text-foreground">{display}</span>
                              <StatusPill tone="muted">{formatProviderGroupLabel(provider)}</StatusPill>
                              {m && !isSelectableModel(m) ? (
                                <StatusPill tone="warn">Unavailable</StatusPill>
                              ) : null}
                            </div>
                            <code className="mt-0.5 block truncate font-mono text-[11px] text-foreground-muted">
                              {id}
                            </code>
                            {m && !isSelectableModel(m) ? (
                              <span className="mt-1 block text-[11px] text-[var(--warning)]">
                                {m.unavailableReason ?? "This model is not runnable now."}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              className="rounded border border-border px-2 py-1 text-xs hover:bg-background-element/80 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label={moveUpLabel}
                              disabled={index === 0}
                              onClick={() => moveInChain(index, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="rounded border border-border px-2 py-1 text-xs hover:bg-background-element/80 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label={moveDownLabel}
                              disabled={index === draftChain.length - 1}
                              onClick={() => moveInChain(index, 1)}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="rounded border border-border px-2 py-1 text-xs text-[var(--error)] hover:bg-background-element/80"
                              aria-label={removeLabel}
                              onClick={() => removeAt(index)}
                            >
                              ✕
                            </button>
                          </div>
                        </li>
                      );
                    })
                  )}
                </ul>

                {showCrossProviderNote ? (
                  <aside
                    role="note"
                    className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-foreground"
                  >
                    Your fallback chain spans multiple providers. Each hop sends your conversation to a
                    different provider; review provider privacy policies before enabling.
                  </aside>
                ) : null}

                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-[12rem] flex-1 text-xs font-medium text-foreground-muted">
                    Add model
                    <select
                      className="mt-1 block w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-sm text-foreground"
                      value={resolvedAddId}
                      onChange={(e) => setAddPick(e.target.value)}
                    >
                      {addCandidates.length === 0 ? (
                        <option value="">All catalog models are in the chain</option>
                      ) : null}
                      {addCandidates.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    onClick={() => appendPick()}
                    disabled={!resolvedAddId || addCandidates.length === 0}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </FieldRow>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void handleSave()} loading={save === "saving"} disabled={!canSave}>
              Save
            </Button>
            {save === "saved" ? <StatusPill tone="ok">Saved</StatusPill> : null}
            {typeof save === "object" ? <StatusPill tone="error">{save.error}</StatusPill> : null}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
