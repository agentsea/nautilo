import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyReport } from "@nautilo/config-guard";
import { ApiError } from "@nautilo/api-client/browser";
import { apiClient } from "../../../lib/api";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import {
  Button,
  FieldRow,
  GuestPlaceholder,
  PermissionPlaceholder,
  SectionCard,
  StatusPill,
  TextInput,
} from "../../settings/ui";
import { ProviderKeyCoverage } from "./provider-key-coverage";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; keys: KeyReport[] }
  | { kind: "error"; message: string }
  | { kind: "forbidden" };

type RowSave = "idle" | "saving" | "saved" | { error: string };

const KEY_DISPLAY_ORDER = [
  "nautilo-gateway", "venice", "openrouter", "elevenlabs", "openai", "anthropic", "google",
  "fireworks", "groq",
];

function displayOrder(key: KeyReport): number {
  if (key.id === "gateway") return KEY_DISPLAY_ORDER.length + 1;
  const index = KEY_DISPLAY_ORDER.indexOf(key.id);
  return index === -1 ? KEY_DISPLAY_ORDER.length : index;
}

type ProviderCredentialsApi = Pick<
  typeof apiClient,
  "getKeySummary" | "setupKeys" | "validateKeys"
>;

export interface ProviderCredentialsEditorProps {
  /** Focused test seam; production uses the shared authenticated client. */
  keyApi?: ProviderCredentialsApi;
  enabled: boolean;
  viewerIsVerified: boolean;
}

function statusPill(status: KeyReport["status"]) {
  switch (status) {
    case "verified":
      return <StatusPill tone="ok">Verified</StatusPill>;
    case "present":
      return <StatusPill tone="info">Set</StatusPill>;
    case "invalid_format":
      return <StatusPill tone="warn">Invalid format</StatusPill>;
    case "invalid_key":
      return <StatusPill tone="error">Rejected by provider</StatusPill>;
    case "unreachable":
      return <StatusPill tone="warn">Unreachable</StatusPill>;
    case "missing":
      return <StatusPill tone="muted">Not set</StatusPill>;
    default: {
      const _exhaustive: never = status;
      return <StatusPill tone="muted">{String(_exhaustive)}</StatusPill>;
    }
  }
}

export function ProviderCredentialsSection() {
  const auth = useAuth();
  const can = useCan();
  return (
    <ProviderCredentialsEditor
      enabled={
        auth.viewer.isVerified && (can("manage_connection_providers") || can("manage_server_settings"))
      }
      viewerIsVerified={auth.viewer.isVerified}
    />
  );
}

export function ProviderCredentialsEditor({
  keyApi = apiClient,
  enabled,
  viewerIsVerified,
}: ProviderCredentialsEditorProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<Record<string, RowSave>>({});
  const savingRowsRef = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const { keys } = await keyApi.getKeySummary();
      setState({ kind: "ready", keys });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setState({ kind: "forbidden" });
      } else {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Failed to load keys",
        });
      }
    }
  }, [keyApi]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  const setRowState = (id: string, next: RowSave) => {
    setSaveState((prev) => ({ ...prev, [id]: next }));
  };

  const saveRow = async (report: KeyReport) => {
    const value = (editing[report.id] ?? "").trim();
    if (!value) {
      setRowState(report.id, { error: "Value required" });
      return;
    }
    if (savingRowsRef.current.has(report.id)) return;
    savingRowsRef.current.add(report.id);
    setRowState(report.id, "saving");
    try {
      const result = await keyApi.setupKeys(
        { [report.envVar]: value },
        true,
      );
      const detail = result.details?.find((d) => d.key === report.envVar);
      if (detail?.action === "failed") {
        setRowState(report.id, {
          error: detail.reason ?? "Rejected by config-guard",
        });
        return;
      }
      if (!result.success) {
        setRowState(report.id, {
          error: result.error ?? "Save failed",
        });
        return;
      }
      setRowState(report.id, "saved");
      setEditing((prev) => {
        const next = { ...prev };
        delete next[report.id];
        return next;
      });
      // Refresh status so the pill reflects the new value.
      await load();
      // The gate owns setup-status polling. This payload-free signal avoids
      // coupling the key editor to its state while letting a newly configured
      // provider unlock the already-open recovery route.
      window.dispatchEvent(new Event("nautilo:provider-keys-saved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setRowState(report.id, {
          error: "You do not have permission to change provider keys.",
        });
      } else {
        setRowState(report.id, {
          error: e instanceof Error ? e.message : "Save failed",
        });
      }
    } finally {
      savingRowsRef.current.delete(report.id);
    }
  };

  const validateAll = async () => {
    setValidating(true);
    setValidateError(null);
    try {
      const { keys } = await keyApi.validateKeys();
      setState({ kind: "ready", keys });
    } catch (e) {
      // A failed validation probe must NOT wipe the already-loaded key list;
      // surface the error separately so the user can still see + edit keys.
      setValidateError(
        e instanceof Error ? e.message : "Validation failed",
      );
    } finally {
      setValidating(false);
    }
  };

  const validateButton =
    state.kind === "ready" ? (
      <Button
        onClick={() => {
          void validateAll();
        }}
        loading={validating}
        title="Hit each provider to confirm the key is accepted."
      >
        Validate all
      </Button>
    ) : null;

  if (!enabled) {
    return (
      <SectionCard
        id="provider-credentials"
        title="API Keys"
        description="Provider keys for the local Nautilo server."
      >
        {/* M129 — distinguish "not signed in" (verify your identity) from
            "signed in but lacks the cap" (no permission). Keys are server
            config available to provider managers and owners. */}
        {viewerIsVerified ? (
          <PermissionPlaceholder what="provider API keys" />
        ) : (
          <GuestPlaceholder what="Provider API keys" kind="credentials" />
        )}
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="provider-credentials"
      title="API Keys"
      description="Add or change API keys for this server. Values are stored by the server and are never shown again. Deployment and identity settings remain platform-controlled."
      actions={validateButton}
    >
      {state.kind === "loading" ? (
        <p className="text-sm text-foreground-muted">Loading…</p>
      ) : state.kind === "error" ? (
        <p className="text-sm text-[var(--error)]">{state.message}</p>
      ) : state.kind === "forbidden" ? (
        <p className="text-sm text-foreground-muted">
          You do not have permission to manage API keys on this server.
        </p>
      ) : state.keys.length === 0 ? (
        <p className="text-sm text-foreground-muted">No keys registered.</p>
      ) : (
        <div>
          {validateError ? (
            <p className="mb-3 text-xs text-[var(--error)]">
              Validation failed: {validateError}
            </p>
          ) : null}
          <ProviderKeyCoverage keys={state.keys} />
          {[...state.keys].sort((a, b) => displayOrder(a) - displayOrder(b)).map((k) => {
            const editingValue = editing[k.id];
            const isEditing = editingValue !== undefined;
            const row = saveState[k.id] ?? "idle";
            return (
              <FieldRow
                key={k.id}
                label={k.name}
                htmlFor={`settings-key-${k.id}`}
                hint={
                  <span>
                    {k.purpose}
                    {k.signupUrl ? (
                      <>
                        {" · "}
                        <a
                          href={k.signupUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline hover:text-foreground"
                        >
                          Get a key
                        </a>
                      </>
                    ) : null}
                  </span>
                }
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    {statusPill(k.status)}
                    <code className="rounded bg-background-element px-1.5 py-0.5 text-[11px] text-foreground-muted">
                      {k.envVar}
                    </code>
                    {k.masked ? (
                      <code className="text-[11px] text-foreground-dim">
                        {k.masked}
                      </code>
                    ) : null}
                    {k.required ? (
                      <StatusPill tone="warn">Required</StatusPill>
                    ) : null}
                  </div>

                  {k.hint ? (
                    <p className="text-xs text-foreground-muted">{k.hint}</p>
                  ) : null}

                  {isEditing ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <TextInput
                          id={`settings-key-${k.id}`}
                          type="password"
                          value={editingValue}
                          onChange={(v) => {
                            setEditing((p) => ({ ...p, [k.id]: v }));
                            if (row !== "idle") setRowState(k.id, "idle");
                          }}
                          placeholder={k.formatHint}
                          // Chrome ignores autoComplete="off" on password fields
                          // and still offers to save them. "new-password" is the
                          // canonical opt-out per the HTML living standard.
                          autoComplete="new-password"
                          ariaLabel={`New value for ${k.envVar}`}
                        />
                        <Button
                          variant="primary"
                          onClick={() => void saveRow(k)}
                          loading={row === "saving"}
                          disabled={!editingValue.trim()}
                        >
                          Save
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditing((p) => {
                              const next = { ...p };
                              delete next[k.id];
                              return next;
                            });
                            // Clear any stale save error/state so the next edit
                            // attempt starts fresh.
                            setRowState(k.id, "idle");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                      {typeof row === "object" ? (
                        <p className="text-xs text-[var(--error)]" role="alert">
                          {row.error}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={() =>
                          setEditing((p) => ({ ...p, [k.id]: "" }))
                        }
                      >
                        {k.status === "missing" ? "Add key" : "Change"}
                      </Button>
                      {row === "saved" ? (
                        <StatusPill tone="ok">Saved</StatusPill>
                      ) : typeof row === "object" ? (
                        <StatusPill tone="error">{row.error}</StatusPill>
                      ) : null}
                    </div>
                  )}
                </div>
              </FieldRow>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
