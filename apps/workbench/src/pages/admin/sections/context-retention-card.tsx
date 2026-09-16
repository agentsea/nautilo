import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { Button } from "../../settings/ui";

const MIN_LIMIT = 10;
const MAX_LIMIT = 100;
const MIN_FULL_TURNS = 0;
const MAX_FULL_TURNS = 10;
const MIN_CONTEXT_PERCENT = 30;
const MAX_CONTEXT_PERCENT = 80;
const MIN_STENOGRAPHER_PRIOR = 0;
const MAX_STENOGRAPHER_PRIOR = 50;

interface ContextDraft {
  recentConversationLimit: string;
  minimumFullTurns: string;
  maxRoomContextPercent: string;
  stenographerPriorConversationLimit: string;
}

const DEFAULT_DRAFT: ContextDraft = {
  recentConversationLimit: "50",
  minimumFullTurns: "1",
  maxRoomContextPercent: "50",
  stenographerPriorConversationLimit: "10",
};

export function ContextRetentionCard() {
  const can = useCan();
  const canRead = can("read_server_settings");
  const canManage = can("manage_server_operations");
  const [saved, setSaved] = useState<{
    recentConversationLimit: number;
    minimumFullTurns: number;
    maxRoomContextPercent: number;
    stenographerPriorConversationLimit: number;
  } | null>(null);
  const [draft, setDraft] = useState<ContextDraft>(DEFAULT_DRAFT);
  const [loading, setLoading] = useState(canRead);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError(null);
    try {
      const config = await apiClient.admin.serverContext.get();
      setSaved(config);
      setDraft({
        recentConversationLimit: String(config.recentConversationLimit),
        minimumFullTurns: String(config.minimumFullTurns),
        maxRoomContextPercent: String(config.maxRoomContextPercent),
        stenographerPriorConversationLimit: String(
          config.stenographerPriorConversationLimit,
        ),
      });
    } catch {
      setError("Context retention setting is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canRead) return null;

  const parsed = {
    recentConversationLimit: Number(draft.recentConversationLimit),
    minimumFullTurns: Number(draft.minimumFullTurns),
    maxRoomContextPercent: Number(draft.maxRoomContextPercent),
    stenographerPriorConversationLimit: Number(
      draft.stenographerPriorConversationLimit,
    ),
  };
  const valid =
    Number.isInteger(parsed.recentConversationLimit) &&
    parsed.recentConversationLimit >= MIN_LIMIT &&
    parsed.recentConversationLimit <= MAX_LIMIT &&
    Number.isInteger(parsed.minimumFullTurns) &&
    parsed.minimumFullTurns >= MIN_FULL_TURNS &&
    parsed.minimumFullTurns <= MAX_FULL_TURNS &&
    Number.isInteger(parsed.maxRoomContextPercent) &&
    parsed.maxRoomContextPercent >= MIN_CONTEXT_PERCENT &&
    parsed.maxRoomContextPercent <= MAX_CONTEXT_PERCENT &&
    Number.isInteger(parsed.stenographerPriorConversationLimit) &&
    parsed.stenographerPriorConversationLimit >= MIN_STENOGRAPHER_PRIOR &&
    parsed.stenographerPriorConversationLimit <= MAX_STENOGRAPHER_PRIOR;
  const changed =
    valid &&
    saved !== null &&
    (parsed.recentConversationLimit !== saved.recentConversationLimit ||
      parsed.minimumFullTurns !== saved.minimumFullTurns ||
      parsed.maxRoomContextPercent !== saved.maxRoomContextPercent ||
      parsed.stenographerPriorConversationLimit !==
        saved.stenographerPriorConversationLimit);

  const save = async () => {
    if (!canManage || !valid) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const config = await apiClient.admin.serverContext.set(parsed);
      setSaved(config);
      setDraft({
        recentConversationLimit: String(config.recentConversationLimit),
        minimumFullTurns: String(config.minimumFullTurns),
        maxRoomContextPercent: String(config.maxRoomContextPercent),
        stenographerPriorConversationLimit: String(
          config.stenographerPriorConversationLimit,
        ),
      });
      setSuccess("Context retention saved.");
    } catch {
      setError("Could not save context retention.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="context-retention-card"
      className="mt-4 rounded-lg border border-border bg-background-panel/50 p-4"
    >
      <h3 className="text-sm font-semibold">Context retention</h3>
      <p className="mt-0.5 text-xs text-foreground-muted">
        Recent conversational messages included verbatim on fresh Room turns.
        Tool activity inside the retained range is included without consuming
        this count.
      </p>

      {loading && saved === null ? (
        <p className="mt-3 text-sm text-foreground-muted">Loading context retention…</p>
      ) : error && saved === null ? (
        <p className="mt-3 text-sm text-error" role="alert">{error}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="recent-conversation-limit"
              className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted"
            >
              Recent messages
            </label>
            <input
              id="recent-conversation-limit"
              data-testid="recent-conversation-limit-input"
              type="number"
              min={MIN_LIMIT}
              max={MAX_LIMIT}
              step={1}
              value={draft.recentConversationLimit}
              disabled={!canManage || saving}
              onInput={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({
                  ...current,
                  recentConversationLimit: value,
                }));
                setSuccess(null);
              }}
              className="mt-1 w-28 rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground disabled:opacity-60"
            />
            <p className="mt-1 text-xs text-foreground-muted">
              {MIN_LIMIT}–{MAX_LIMIT}; default 50.
            </p>
          </div>
          <div>
            <label
              htmlFor="minimum-full-turns"
              className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted"
            >
              Minimum full turns
            </label>
            <input
              id="minimum-full-turns"
              data-testid="minimum-full-turns-input"
              type="number"
              min={MIN_FULL_TURNS}
              max={MAX_FULL_TURNS}
              step={1}
              value={draft.minimumFullTurns}
              disabled={!canManage || saving}
              onInput={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({
                  ...current,
                  minimumFullTurns: value,
                }));
                setSuccess(null);
              }}
              className="mt-1 w-28 rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground disabled:opacity-60"
            />
            <p className="mt-1 text-xs text-foreground-muted">
              {MIN_FULL_TURNS}–{MAX_FULL_TURNS}; default 1.
            </p>
          </div>
          <div>
            <label
              htmlFor="max-room-context-percent"
              className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted"
            >
              Maximum Room context
            </label>
            <input
              id="max-room-context-percent"
              data-testid="max-room-context-percent-input"
              type="number"
              min={MIN_CONTEXT_PERCENT}
              max={MAX_CONTEXT_PERCENT}
              step={1}
              value={draft.maxRoomContextPercent}
              disabled={!canManage || saving}
              onInput={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({
                  ...current,
                  maxRoomContextPercent: value,
                }));
                setSuccess(null);
              }}
              className="mt-1 w-28 rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground disabled:opacity-60"
            />
            <p className="mt-1 text-xs text-foreground-muted">
              {MIN_CONTEXT_PERCENT}–{MAX_CONTEXT_PERCENT}% of the model window; default 50%.
            </p>
          </div>
          <div>
            <label
              htmlFor="stenographer-prior-conversation-limit"
              className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted"
            >
              Stenographer previous context
            </label>
            <input
              id="stenographer-prior-conversation-limit"
              data-testid="stenographer-prior-conversation-limit-input"
              type="number"
              min={MIN_STENOGRAPHER_PRIOR}
              max={MAX_STENOGRAPHER_PRIOR}
              step={1}
              value={draft.stenographerPriorConversationLimit}
              disabled={!canManage || saving}
              onInput={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({
                  ...current,
                  stenographerPriorConversationLimit: value,
                }));
                setSuccess(null);
              }}
              className="mt-1 w-28 rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground disabled:opacity-60"
            />
            <p className="mt-1 max-w-64 text-xs text-foreground-muted">
              {MIN_STENOGRAPHER_PRIOR}–{MAX_STENOGRAPHER_PRIOR} prior
              conversational messages; default 10. This does not change the
              five-message/two-minute processing trigger.
            </p>
          </div>
          {canManage ? (
            <Button
              type="button"
              ariaLabel="Save context retention"
              variant="primary"
              loading={saving}
              disabled={!changed || saving}
              onClick={() => {
                void save();
              }}
            >
              Save
            </Button>
          ) : (
            <p className="pb-2 text-xs text-foreground-muted">
              Read-only — <code>manage_server_operations</code> is required to change this.
            </p>
          )}
        </div>
      )}

      {!loading && saved !== null && !valid ? (
        <p className="mt-2 text-sm text-error" role="alert">
          Enter whole numbers within each setting’s displayed range.
        </p>
      ) : null}
      {error && saved !== null ? (
        <p className="mt-2 text-sm text-error" role="alert">{error}</p>
      ) : null}
      {success ? (
        <p className="mt-2 text-sm text-foreground-muted" data-testid="context-retention-success">
          {success}
        </p>
      ) : null}
    </div>
  );
}
