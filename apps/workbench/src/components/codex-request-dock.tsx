import { useMemo, useState } from "react";
import type { CodexRequestEvent, CodexRequestResponse } from "@nautilo/types";
import { useCodexRequests, type CodexRequestView } from "../adapters/runtime-contexts";

const DECISION_LABELS = {
  approve: "Allow once",
  approve_for_session: "Allow for session",
  deny: "Deny",
  cancel: "Cancel",
} as const;

function localOperationCopy(kind: "command" | "file"): string {
  return kind === "command"
    ? "A task wants to run a local operation on this workstation."
    : "A task wants to change files in this workspace.";
}

function requestTitle(request: CodexRequestEvent["request"]): string {
  switch (request.kind) {
    case "command_approval_required":
      return "Local operation requested";
    case "network_approval_required":
      return "Network connection requested";
    case "file_change_approval_required":
      return "File change requested";
    case "permissions_approval_required":
      return "Additional access requested";
    case "user_input_required":
      return "Input needed";
    case "permission_selection_required":
      return "Permission requested";
  }
}

function approvalResponse(
  request: Extract<
    CodexRequestEvent["request"],
    { readonly kind: "command_approval_required" | "network_approval_required" | "file_change_approval_required" }
  >,
  decision: "approve" | "approve_for_session" | "deny" | "cancel",
): CodexRequestResponse {
  return { kind: request.kind, decision };
}

function permissionSummary(
  request: Extract<CodexRequestEvent["request"], { readonly kind: "permissions_approval_required" }>,
): string {
  const categories: string[] = [];
  if (request.permissions.network) categories.push("network access");
  if (request.permissions.fileSystem) {
    const { readPathCount, writePathCount } = request.permissions.fileSystem;
    categories.push(`${readPathCount} read and ${writePathCount} write filesystem path${readPathCount + writePathCount === 1 ? "" : "s"}`);
  }
  return categories.length > 0
    ? `A task is requesting ${categories.join(" and ")}.`
    : "A task is requesting additional local access.";
}

function CodexRequestCard({ requestView }: { requestView: CodexRequestView }) {
  const { state, respond, dismiss } = useCodexRequests();
  const { event: requestEvent, availability } = requestView;
  const { request } = requestEvent;
  const unavailable = availability === "unavailable";
  const title = unavailable ? "Question ended" : requestTitle(request);
  const submitting = state.submittingRequestId === requestEvent.requestId;
  // Responses are a single ordered browser→server handshake. Disable the
  // whole visible dock while one POST is in flight so two cards cannot race.
  const responding = state.submittingRequestId !== null;
  const error = state.errors[requestEvent.requestId] || null;

  const submit = async (response: CodexRequestResponse): Promise<void> => {
    if (responding) return;
    await respond(requestEvent.requestId, response);
  };

  return (
    <section
      data-testid="codex-request-card"
      data-request-id={requestEvent.requestId}
      aria-label={title}
      className="min-w-0 border-t border-sky-500/30 bg-sky-500/5 px-4 py-3"
    >
      <div className="min-w-0">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>

        {unavailable ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-xs text-foreground-muted">
              This question can’t continue because the connection or Nautilo restarted. Start a new task.
            </p>
            <button
              type="button"
              onClick={() => dismiss(requestEvent.requestId)}
              className="rounded-md border border-border bg-background-element px-2.5 py-1 text-xs text-foreground-muted hover:border-border-strong hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {!unavailable && request.kind === "command_approval_required" ? (
          <ApprovalActions
            copy={localOperationCopy("command")}
            request={request}
            responding={responding}
            showLocalDetail
            onRespond={submit}
          />
        ) : null}

        {!unavailable && request.kind === "network_approval_required" ? (
          <ApprovalActions
            copy={`A task wants to connect to ${request.network.host} over ${request.network.protocol}.`}
            request={request}
            responding={responding}
            showLocalDetail={false}
            onRespond={submit}
          />
        ) : null}

        {!unavailable && request.kind === "file_change_approval_required" ? (
          <ApprovalActions
            copy={localOperationCopy("file")}
            request={request}
            responding={responding}
            showLocalDetail
            onRespond={submit}
          />
        ) : null}

        {!unavailable && request.kind === "permissions_approval_required" ? (
          <PermissionActions
            request={request}
            responding={responding}
            onRespond={submit}
          />
        ) : null}

        {!unavailable && request.kind === "user_input_required" ? (
          <UserInputForm
            request={request}
            responding={responding}
            onRespond={submit}
          />
        ) : null}

        {!unavailable && request.kind === "permission_selection_required" ? (
          <div className="mt-3">
            <p className="text-xs text-foreground-muted">
              Permission requested for {request.tool.title ?? "a local tool"}.
            </p>
            {request.detail?.state === "shown" ? (
              <>
                <p className="mt-2 text-xs text-foreground-muted">Proposed action — review before allowing. This is not a safety verdict.</p>
                <pre aria-label="Proposed action" tabIndex={0} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-xs">{request.detail.text}</pre>
              </>
            ) : (
              <p role="status" className="mt-2 text-xs text-foreground-muted">
                Action details are unavailable{request.detail?.state === "withheld" ? ` (${request.detail.reason.replaceAll("_", " ")})` : " on this connection"}. Allow is disabled. Deny or cancel, then ask the task to propose an inspectable action.
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {request.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={responding || (request.detail?.state !== "shown" && option.id !== "deny")}
                  onClick={() => void submit({
                    kind: "permission_selection_required",
                    outcome: { kind: "selected", optionId: option.id },
                  })}
                  className="rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {option.label}
                </button>
              ))}
              <button
                type="button"
                disabled={responding}
                onClick={() => void submit({ kind: "permission_selection_required", outcome: { kind: "cancelled" } })}
                className="rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground-muted hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {!unavailable && submitting ? <p className="mt-2 text-[11px] text-foreground-muted">Sending response…</p> : null}
        {!unavailable && error ? <p role="alert" className="mt-2 text-[11px] text-[var(--error)]">{error}</p> : null}
      </div>
    </section>
  );
}

function ApprovalActions({
  copy,
  request,
  responding,
  showLocalDetail,
  onRespond,
}: {
  copy: string;
  request: Extract<
    CodexRequestEvent["request"],
    { readonly kind: "command_approval_required" | "network_approval_required" | "file_change_approval_required" }
  >;
  responding: boolean;
  showLocalDetail: boolean;
  onRespond: (response: CodexRequestResponse) => Promise<void>;
}) {
  return (
    <>
      <p className="mt-1 text-xs text-foreground-muted">{copy}</p>
      {showLocalDetail ? (
        <p className="mt-1 text-[11px] text-foreground-muted">Command and path details stay on this device.</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {request.options.map((decision) => (
          <button
            key={decision}
            type="button"
            disabled={responding}
            data-decision={decision}
            onClick={() => void onRespond(approvalResponse(request, decision))}
            className={decision === "deny" || decision === "cancel"
              ? "rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground-muted hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              : "rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"}
          >
            {DECISION_LABELS[decision]}
          </button>
        ))}
      </div>
    </>
  );
}

function PermissionActions({
  request,
  responding,
  onRespond,
}: {
  request: Extract<CodexRequestEvent["request"], { readonly kind: "permissions_approval_required" }>;
  responding: boolean;
  onRespond: (response: CodexRequestResponse) => Promise<void>;
}) {
  const networkOffered = request.permissions.network !== null;
  const fileSystemOffered = request.permissions.fileSystem !== null;
  const [network, setNetwork] = useState(networkOffered);
  const [fileSystem, setFileSystem] = useState(fileSystemOffered);
  const grants = useMemo(() => ({ network, fileSystem }), [network, fileSystem]);

  const allow = (scope: "turn" | "session") =>
    onRespond({ kind: "permissions_approval_required", grants, scope });

  return (
    <>
      <p className="mt-1 text-xs text-foreground-muted">{permissionSummary(request)}</p>
      <fieldset className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-foreground">
        <legend className="sr-only">Choose the requested access to allow</legend>
        {networkOffered ? (
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={network}
              disabled={responding}
              onChange={(event) => setNetwork(event.currentTarget.checked)}
            />
            Network access
          </label>
        ) : null}
        {fileSystemOffered ? (
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={fileSystem}
              disabled={responding}
              onChange={(event) => setFileSystem(event.currentTarget.checked)}
            />
            Filesystem access
          </label>
        ) : null}
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={responding}
          onClick={() => void allow("turn")}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          Allow selected for this turn
        </button>
        <button
          type="button"
          disabled={responding}
          onClick={() => void allow("session")}
          className="rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          Allow selected for this session
        </button>
        <button
          type="button"
          disabled={responding}
          onClick={() => void onRespond({
            kind: "permissions_approval_required",
            grants: { network: false, fileSystem: false },
            scope: "turn",
          })}
          className="rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground-muted hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          Deny
        </button>
      </div>
    </>
  );
}

function UserInputForm({
  request,
  responding,
  onRespond,
}: {
  request: Extract<CodexRequestEvent["request"], { readonly kind: "user_input_required" }>;
  responding: boolean;
  onRespond: (response: CodexRequestResponse) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [otherAnswers, setOtherAnswers] = useState<Readonly<Record<string, string>>>({});
  const answerValues = (question: (typeof request.questions)[number]): readonly string[] => {
    const selected = answers[question.id] ?? [];
    const other = otherAnswers[question.id] ?? "";
    if (question.multiSelect === true) return other.length > 0 ? [...selected, other] : selected;
    return other.length > 0 ? [other] : selected.slice(0, 1);
  };
  const complete = request.questions.every((question) => answerValues(question).length > 0);

  const setAnswer = (questionId: string, answer: string): void => {
    setAnswers((previous) => ({ ...previous, [questionId]: answer.length > 0 ? [answer] : [] }));
    setOtherAnswers((previous) => ({ ...previous, [questionId]: "" }));
  };

  const toggleAnswer = (questionId: string, answer: string, selected: boolean): void => {
    setAnswers((previous) => {
      const current = previous[questionId] ?? [];
      const next = selected
        ? [...current.filter((value) => value !== answer), answer]
        : current.filter((value) => value !== answer);
      return { ...previous, [questionId]: next };
    });
  };

  const setOtherAnswer = (questionId: string, value: string, multiSelect: boolean): void => {
    setOtherAnswers((previous) => ({ ...previous, [questionId]: value }));
    if (!multiSelect) setAnswers((previous) => ({ ...previous, [questionId]: [] }));
  };

  return (
    <form
      className="mt-3 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete || responding) return;
        void onRespond({
          kind: "user_input_required",
          answers: Object.fromEntries(request.questions.map((question) => [question.id, [...answerValues(question)]])),
        });
      }}
    >
      {request.questions.map((question, questionIndex) => (
        <fieldset key={question.id} className="min-w-0">
          <legend className="text-xs font-medium text-foreground">{question.header}</legend>
          <p className="mt-1 text-xs text-foreground-muted">{question.prompt}</p>
          {question.options ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {question.options.map((option) => (
                <label
                  key={option.id}
                  className="inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-background-element px-2.5 py-1.5 text-xs text-foreground"
                >
                  <input
                    type={question.multiSelect === true ? "checkbox" : "radio"}
                    name={`task-request-${questionIndex}`}
                    checked={question.multiSelect === true
                      ? answers[question.id]?.includes(option.id) ?? false
                      : answers[question.id]?.[0] === option.id}
                    disabled={responding}
                    onChange={(event) => {
                      if (question.multiSelect === true) {
                        toggleAnswer(question.id, option.id, event.currentTarget.checked);
                      } else {
                        setAnswer(question.id, option.id);
                      }
                    }}
                  />
                  <span className="min-w-0">
                    <span>{option.label}</span>
                    {option.description ? <span className="ml-1 text-foreground-muted">{option.description}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          {question.options === null || question.allowOther ? (
            <label className="mt-2 block text-[11px] text-foreground-muted">
              {question.options ? "Other" : "Your answer"}
              <input
                type={question.secret ? "password" : "text"}
                value={otherAnswers[question.id] ?? ""}
                disabled={responding}
                onChange={(event) => {
                  setOtherAnswer(question.id, event.currentTarget.value, question.multiSelect === true);
                }}
                className="mt-1 block w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary"
              />
            </label>
          ) : null}
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!complete || responding}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          Send answers
        </button>
        {request.autoResolutionMs !== null ? (
          <span className="text-[11px] text-foreground-muted">The task may continue automatically if you do not respond.</span>
        ) : null}
      </div>
    </form>
  );
}

/** Inline, composer-adjacent native request surface. */
export function CodexRequestDock() {
  const { state } = useCodexRequests();
  if (state.requests.length === 0) return null;

  return (
    <div
      data-testid="codex-request-dock"
      role="region"
      aria-label="Task request status"
      className="w-full border-t border-sky-500/30 bg-background"
    >
      {state.requests.map((requestView) => (
        <CodexRequestCard key={requestView.event.requestId} requestView={requestView} />
      ))}
    </div>
  );
}
