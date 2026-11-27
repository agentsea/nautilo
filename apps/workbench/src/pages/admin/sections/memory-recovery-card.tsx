import { useState, type FormEvent } from "react";
import type {
  MemoryRecoveryJob,
  MemoryRecoveryPreview,
  MemoryRecoveryRequest,
  MemoryRecoveryResult,
} from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";

const buttonClass = "rounded-md border border-border bg-background-element px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-background-panel disabled:opacity-50";
const inputClass = "rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted disabled:opacity-50";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background-element px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-foreground-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}

export function memoryRecoveryStatusText(status: MemoryRecoveryResult["status"]): string {
  switch (status) {
    case "queued":
      return "Queued. Current state was refreshed; refresh this Room later to watch progress.";
    case "already_queued":
      return "Conflict: recovery is already queued. Current state was refreshed; refresh this Room later to watch progress.";
    case "blocked":
      return "Blocked. Review the refreshed job failure before trying again.";
    case "stale":
      return "The preview was stale. The same Room was refreshed; review it before running again.";
  }
}

function actionLabel(job: MemoryRecoveryJob): string {
  switch (job.action) {
    case "retry_with_model": return "Run with selected model";
    case "retry_review": return "Retry review";
    case "reconcile_review": return "Reconcile and rerun";
    case "blocked": return "Blocked";
  }
}

export function MemoryRecoveryCard() {
  const can = useCan();
  const canRead = can("read_server_settings");
  const canManage = can("manage_server_operations");
  const [roomId, setRoomId] = useState("");
  const [preview, setPreview] = useState<MemoryRecoveryPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [modelsByJob, setModelsByJob] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!canRead) return null;

  const loadPreview = async (requestedRoomId = roomId.trim()) => {
    if (!requestedRoomId || previewing || running !== null) return;
    setPreviewing(true);
    setError(null);
    try {
      const next = await apiClient.admin.memoryRecovery.preview(requestedRoomId);
      setPreview(next);
      setModelsByJob({});
    } catch {
      setPreview(null);
      setError("Recovery preview unavailable. No recovery work was started.");
    } finally {
      setPreviewing(false);
    }
  };

  const submitPreview = (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    void loadPreview();
  };

  const run = async (key: string, request: MemoryRecoveryRequest) => {
    if (!canManage || running !== null || !preview || request.roomId !== preview.roomId) return;
    setRunning(key);
    setError(null);
    setNotice(null);
    try {
      const result = await apiClient.admin.memoryRecovery.run(request);
      setNotice(memoryRecoveryStatusText(result.status));
      try {
        const verified = await apiClient.admin.memoryRecovery.preview(request.roomId);
        setPreview(verified);
        setModelsByJob({});
      } catch {
        setPreview(null);
        setModelsByJob({});
        setError("The recovery request returned, but verification refresh failed. Preview this Room again before another action.");
      }
    } catch {
      setPreview(null);
      setModelsByJob({});
      setError("Recovery could not be confirmed. Preview this Room again before retrying.");
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-border bg-background-panel/50 p-4" data-testid="memory-recovery-card">
      <div>
        <h3 className="text-sm font-semibold">Recovery</h3>
        <p className="mt-0.5 text-xs text-foreground-muted">
          Preview one Room, then explicitly run recovery for its current Journal or affected job.
        </p>
      </div>

      <form className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={submitPreview}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
          Room ID
          <input
            className={inputClass}
            value={roomId}
            placeholder="Room ID"
            autoComplete="off"
            disabled={previewing || running !== null}
            onChange={(event) => {
              setRoomId(event.target.value);
              setPreview(null);
              setModelsByJob({});
              setError(null);
              setNotice(null);
            }}
          />
        </label>
        <button className={buttonClass} type="submit" disabled={!roomId.trim() || previewing || running !== null}>
          {previewing ? "Previewing…" : "Preview"}
        </button>
      </form>
      <p className="mt-2 text-xs text-foreground-muted">Preview only reads recovery state. It does not start model work.</p>

      {error ? <p className="mt-3 text-sm text-error" role="alert">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm" role="status">{notice}</p> : null}

      {preview ? (
        <div className="mt-4 space-y-4" data-testid="memory-recovery-preview">
          <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
            <span className="font-medium text-foreground">Room {preview.roomId}</span>
            <span>Previewed {new Date(preview.generatedAt).toLocaleString()}</span>
          </div>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Fact label="Journal cursor" value={`${preview.journal.cursor}${preview.journal.target === null ? "" : ` / ${preview.journal.target}`}`} />
            <Fact label="Journal generation" value={preview.journal.generation.toLocaleString()} />
            <Fact label="Journal rebuild" value={preview.journal.rebuild.replaceAll("_", " ")} />
            <Fact label="Journal last complete" value={preview.journal.lastCompletedAt ? new Date(preview.journal.lastCompletedAt).toLocaleString() : "None"} />
            <Fact label="Reflection complete" value={preview.reflection.completed.toLocaleString()} />
            <Fact label="Reflection pending" value={preview.reflection.pending.toLocaleString()} />
            <Fact label="Memory covered" value={preview.memory.covered.toLocaleString()} />
            <Fact label="Memory pending" value={preview.memory.pending.toLocaleString()} />
            <Fact label="Latest Memory outcome" value={preview.memory.latestOutcome?.replaceAll("_", " ") ?? "None"} />
          </dl>

          <div className="rounded-md border border-border/60 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">Journal regeneration</h4>
            <p className="mt-1 text-xs text-foreground-muted">
              Regenerates the existing whole-Room Journal and can incur model usage. The server preserves source messages.
            </p>
            {preview.journal.rebuild === "available" && canManage ? (
              <button
                type="button"
                className={`${buttonClass} mt-2`}
                disabled={running !== null}
                onClick={() => void run("journal", {
                  roomId: preview.roomId,
                  action: "rebuild_journal",
                  generation: preview.journal.generation,
                  cursor: preview.journal.cursor,
                  confirmBillableWork: true,
                })}
              >
                {running === "journal" ? "Queuing…" : "Regenerate Room Journal"}
              </button>
            ) : (
              <p className="mt-2 text-xs font-medium capitalize">{preview.journal.rebuild.replaceAll("_", " ")}</p>
            )}
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">Affected jobs</h4>
            {preview.jobs.length === 0 ? (
              <p className="mt-2 text-sm text-foreground-muted">No recovery job is currently available for this Room.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {preview.jobs.map((job) => {
                  const eligibleModels = preview.models.filter((model) =>
                    model.lanes.includes(job.lane) && model.id !== job.modelId
                  );
                  const selectedModel = modelsByJob[job.id] ?? "";
                  return (
                    <li key={job.id} className="rounded-md border border-border/60 bg-background-element p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold capitalize text-foreground">{job.lane} recovery</p>
                        <span className="text-foreground-muted">Job {job.id}</span>
                      </div>
                      <p className="mt-1 text-foreground-muted">Last step: {job.stage.replaceAll("_", " ")}</p>
                      <p className="mt-1 text-foreground-muted">Failure: {job.reason.replaceAll("_", " ")}</p>
                      {job.modelId ? <p className="mt-1 text-foreground-muted">Last model: {job.modelId}</p> : null}
                      {job.action === "reconcile_review" ? (
                        <p className="mt-2 text-foreground-muted">
                          First reconcile the local receipt. The approved one-time rerun can incur another model charge.
                        </p>
                      ) : null}
                      {job.action === "retry_with_model" && eligibleModels.length > 0 ? (
                        <label className="mt-2 flex max-w-md flex-col gap-1 font-medium">
                          Connected model for this job
                          <select
                            className={inputClass}
                            value={selectedModel}
                            disabled={!canManage || running !== null}
                            onChange={(event) => setModelsByJob((current) => ({ ...current, [job.id]: event.target.value }))}
                          >
                            <option value="">Choose a connected model</option>
                            {eligibleModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                          </select>
                        </label>
                      ) : null}
                      {job.action === "retry_with_model" && eligibleModels.length === 0 ? (
                        <p className="mt-2 font-medium text-foreground-muted">No other connected model is eligible for this job.</p>
                      ) : null}
                      {job.action === "blocked" ? (
                        <p className="mt-2 font-medium text-error">Blocked — no safe recovery action is currently available.</p>
                      ) : canManage ? (
                        <button
                          type="button"
                          className={`${buttonClass} mt-2`}
                          disabled={running !== null || (job.action === "retry_with_model" && !selectedModel)}
                          onClick={() => {
                            const base = { roomId: preview.roomId, jobId: job.id, version: job.version };
                            if (job.action === "retry_with_model") {
                              if (!selectedModel) return;
                              void run(job.id, { ...base, action: job.action, lane: job.lane, modelId: selectedModel });
                            } else if (job.action === "retry_review") {
                              void run(job.id, { ...base, action: job.action });
                            } else if (job.action === "reconcile_review") {
                              void run(job.id, { ...base, action: job.action, confirmBillableWork: true });
                            }
                          }}
                        >
                          {running === job.id ? "Queuing…" : actionLabel(job)}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {preview.hasMoreJobs ? <p className="mt-2 text-xs text-foreground-muted">More affected jobs exist. Recover the current listed jobs, then preview again.</p> : null}
          </div>
          {!canManage ? (
            <p className="text-xs text-foreground-muted">
              Read-only — <code>manage_server_operations</code> is required to run recovery.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
