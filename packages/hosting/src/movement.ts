import {
  evaluatePreMutation,
  type PreMutationEvaluation,
} from "./pre-mutation";
import type {
  CapabilityStatus,
  CoreReadiness,
  HostingBackend,
  HostingNotice,
  HostingRepairTarget,
  InfrastructureState,
} from "./types";

/** The two projections over this engine; neither performs terminal I/O here. */
export type HostingInteractionMode = "tty" | "noninteractive";

/** An explicit choice for an already-incomplete launch receipt. */
export type IncompleteReceiptDecision = "resume" | "destroy" | "exit";

/** The only TTY choices allowed when a documented credential source is invalid. */
export type InvalidCredentialDecision =
  | "repair-source"
  | "masked-entry"
  | "skip-optional"
  | "exit";

/** The only TTY choices allowed when a core capability is unavailable or invalid. */
export type CoreGapDecision = "add-key" | "accept-core-degraded" | "exit";

/** Browser OAuth state supplied by the projection after a browser attempt. */
export type HostAuthorizationState = "pending" | "authorized" | "failed";

/** The recovery choice shown after a failed or expired host authorization. */
export type AuthorizationFailureDecision = "retry" | "switch-backend" | "exit";

/** Whether the signed immutable release was already verified by its own seam. */
export type ReleaseVerification = "verified" | "missing" | "invalid";

/** Best-effort, non-secret cost disclosure shown before a billable mutation. */
export interface HostingCostDisclosure {
  readonly payer: string;
  readonly estimate: string;
}

/**
 * Complete, non-secret input to the locked graph before its first provider
 * mutation. TTY and noninteractive callers supply the same fields; only a TTY
 * may receive a `needs-input` result.
 */
export interface PreMutationMovementInput {
  readonly mode: HostingInteractionMode;
  /** `--yes`: acknowledges only the ordinary billable-mutation confirmation. */
  readonly yes: boolean;
  /** `--allow-core-degraded`: the only noninteractive degradation consent. */
  readonly allowCoreDegraded: boolean;
  readonly backend?: HostingBackend | undefined;
  readonly release: ReleaseVerification;
  readonly cost?: HostingCostDisclosure | undefined;
  readonly infrastructure: InfrastructureState;
  readonly capabilities: readonly CapabilityStatus[];
  /** `false` means the documented credential source failed parsing or validation. */
  readonly credentialSourcesValid: boolean;
  /** Proves whether every invalid source may be skipped without losing core coverage. */
  readonly invalidCredentialScope?: "optional-only" | "includes-core" | undefined;
  readonly invalidCredentialDecision?: InvalidCredentialDecision | undefined;
  readonly coreGapDecision?: CoreGapDecision | undefined;
  /** Explicit TTY confirmation. It is ignored by noninteractive mode. */
  readonly billableMutationConfirmed?: boolean | undefined;
  readonly authorization: HostAuthorizationState;
  readonly authorizationFailureDecision?: AuthorizationFailureDecision | undefined;
  /** Required with `switch-backend`; it must differ from the failed backend. */
  readonly switchBackendTo?: HostingBackend | undefined;
  readonly incompleteReceipt?: boolean | undefined;
  /** The graph requires receipt/live-resource inspection before its decision. */
  readonly incompleteReceiptInspected?: boolean | undefined;
  readonly incompleteReceiptDecision?: IncompleteReceiptDecision | undefined;
  /** Explicit non-secret consent persisted with an incomplete degraded plan. */
  readonly incompleteReceiptCoreDegradedConsent?: boolean | undefined;
}

/** A data instruction for the thin TTY/JSON projections, never terminal I/O. */
export type PreMutationNextAction =
  | "choose-receipt-action"
  | "inspect-incomplete-receipt"
  | "choose-backend"
  | "repair-credentials"
  | "choose-core-gap-action"
  | "confirm-billable-mutation"
  | "authorize-host"
  | "choose-authorization-recovery"
  | "restart-backend-plan"
  | "provision"
  | "resume-provisioning"
  | "destroy-incomplete-receipt"
  | "none";

/**
 * A result of evaluating one complete graph pass. `mutationAuthorized` means
 * that the next action is a provider mutation; no such mutation happens here.
 */
export interface PreMutationMovementResult {
  readonly outcome:
    | "needs-input"
    | "blocked"
    | "cancelled"
    | "requires-receipt-inspection"
    | "requires-authorization"
    | "requires-replan"
    | "ready-to-provision"
    | "ready-to-resume"
    | "ready-to-destroy"
    | "resources-retained";
  readonly nextAction: PreMutationNextAction;
  readonly infrastructure: InfrastructureState;
  readonly coreReadiness: CoreReadiness;
  readonly capabilities: readonly CapabilityStatus[];
  readonly notices: readonly HostingNotice[];
  readonly coreDegradedConsent: boolean;
  readonly mutationAuthorized: boolean;
  /** Backend chosen after failed OAuth; it must be fully replanned before use. */
  readonly restartBackend?: HostingBackend | undefined;
}

const rerunPlanTarget: HostingRepairTarget = { kind: "rerun-plan" };

function notice(
  severity: HostingNotice["severity"],
  code: HostingNotice["code"],
  message: string,
): HostingNotice {
  return { severity, code, message, repairTarget: rerunPlanTarget };
}

function fromEvaluation(
  evaluation: PreMutationEvaluation,
  overrides: Pick<
    PreMutationMovementResult,
    "outcome" | "nextAction" | "mutationAuthorized"
  >,
  notices: readonly HostingNotice[] = evaluation.notices,
): PreMutationMovementResult {
  return {
    ...overrides,
    infrastructure: evaluation.infrastructure,
    coreReadiness: evaluation.coreReadiness,
    capabilities: evaluation.capabilities,
    notices,
    coreDegradedConsent: evaluation.coreDegradedConsent,
  };
}

function evaluationFor(
  input: PreMutationMovementInput,
  coreDegradedConsent: boolean,
): PreMutationEvaluation {
  return evaluatePreMutation({
    infrastructure: input.infrastructure,
    capabilities: input.capabilities,
    coreDegradedConsent,
  });
}

function needsInput(
  evaluation: PreMutationEvaluation,
  nextAction: Exclude<PreMutationNextAction, "none">,
): PreMutationMovementResult {
  return fromEvaluation(evaluation, {
    outcome: "needs-input",
    nextAction,
    mutationAuthorized: false,
  });
}

function cancelled(
  evaluation: PreMutationEvaluation,
  message: string,
): PreMutationMovementResult {
  return fromEvaluation(
    evaluation,
    { outcome: "cancelled", nextAction: "none", mutationAuthorized: false },
    [...evaluation.notices, notice("info", "hosting.cancelled", message)],
  );
}

function blocked(
  evaluation: PreMutationEvaluation,
  code: Extract<
    HostingNotice["code"],
    | "hosting.input-invalid"
    | "hosting.release-invalid"
    | "hosting.cost-unavailable"
    | "hosting.confirmation-required"
    | "hosting.receipt-action-required"
  >,
  message: string,
): PreMutationMovementResult {
  return fromEvaluation(
    evaluation,
    { outcome: "blocked", nextAction: "none", mutationAuthorized: false },
    [...evaluation.notices, notice("blocking", code, message)],
  );
}

/**
 * Pure implementation of every pre-mutation path in the locked D488 graph.
 *
 * The projection supplies resolved/validated non-secret facts and decisions.
 * This function returns the next question, recovery instruction, terminal
 * result, or authorization to perform the first provider mutation. In
 * particular, `yes` never flows into `coreDegradedConsent`.
 */
export function evaluatePreMutationMovement(
  input: PreMutationMovementInput,
): PreMutationMovementResult {
  const neutralEvaluation = evaluationFor(input, false);

  if (input.incompleteReceipt === true) {
    const receiptEvaluation = evaluationFor(
      input,
      input.incompleteReceiptCoreDegradedConsent === true,
    );
    if (input.incompleteReceiptInspected !== true) {
      return fromEvaluation(receiptEvaluation, {
        outcome: "requires-receipt-inspection",
        nextAction: "inspect-incomplete-receipt",
        mutationAuthorized: false,
      });
    }

    if (input.incompleteReceiptDecision === undefined) {
      return input.mode === "tty"
        ? needsInput(receiptEvaluation, "choose-receipt-action")
        : blocked(
            receiptEvaluation,
            "hosting.receipt-action-required",
            "An incomplete launch receipt requires an explicit resume, destroy, or exit decision.",
          );
    }

    if (input.incompleteReceiptDecision === "exit") {
      return fromEvaluation(
        receiptEvaluation,
        { outcome: "resources-retained", nextAction: "none", mutationAuthorized: false },
        [
          ...receiptEvaluation.notices,
          notice(
            "warning",
            "hosting.resources-retained",
            "Incomplete-launch resources are retained and must remain visible in the receipt.",
          ),
        ],
      );
    }

    if (input.incompleteReceiptDecision === "destroy") {
      return fromEvaluation(receiptEvaluation, {
        outcome: "ready-to-destroy",
        nextAction: "destroy-incomplete-receipt",
        // The destroy lifecycle must re-check OAuth before it mutates. The
        // locked graph only records the explicit receipt decision at this node.
        mutationAuthorized: false,
      });
    }

    if (receiptEvaluation.outcome === "blocked") {
      return fromEvaluation(receiptEvaluation, {
        outcome: "blocked",
        nextAction: "none",
        mutationAuthorized: false,
      });
    }

    if (input.authorization === "authorized") {
      return fromEvaluation(receiptEvaluation, {
        outcome: "ready-to-resume",
        nextAction: "resume-provisioning",
        mutationAuthorized: true,
      });
    }

    return authorizationResult(input, receiptEvaluation);
  }

  if (input.backend === undefined) {
    return input.mode === "tty"
      ? needsInput(neutralEvaluation, "choose-backend")
      : blocked(
          neutralEvaluation,
          "hosting.input-invalid",
          "Noninteractive deployment requires an explicit supported backend.",
        );
  }

  if (!input.credentialSourcesValid) {
    return invalidCredentialResult(input, neutralEvaluation);
  }

  const coreGapResult = resolveCoreGap(input, neutralEvaluation);
  if (coreGapResult !== undefined) {
    return coreGapResult;
  }

  let evaluation = evaluationFor(
    input,
    input.mode === "noninteractive"
      ? input.allowCoreDegraded
      : input.coreGapDecision === "accept-core-degraded",
  );

  if (input.release !== "verified") {
    return blocked(
      evaluation,
      "hosting.release-invalid",
      input.release === "missing"
        ? "A verified immutable release is required before deployment."
        : "The selected release failed immutable-manifest verification.",
    );
  }

  if (
    input.cost === undefined ||
    input.cost.payer.trim().length === 0 ||
    input.cost.estimate.trim().length === 0
  ) {
    evaluation = {
      ...evaluation,
      notices: [
        ...evaluation.notices,
        notice(
          "warning",
          "hosting.cost-unavailable",
          "A reliable cost estimate is not yet available; deployment may continue after the ordinary billable-mutation confirmation.",
        ),
      ],
    };
  }

  if (input.mode === "noninteractive" && !input.yes) {
    return blocked(
      evaluation,
      "hosting.confirmation-required",
      "Noninteractive billable deployment requires explicit --yes confirmation.",
    );
  }

  const confirmation =
    input.mode === "noninteractive" ? true : input.billableMutationConfirmed;
  if (confirmation === undefined) {
    return needsInput(evaluation, "confirm-billable-mutation");
  }
  if (!confirmation) {
    return cancelled(evaluation, "Billable deployment was not confirmed.");
  }

  if (input.authorization === "authorized") {
    return fromEvaluation(evaluation, {
      outcome: "ready-to-provision",
      nextAction: "provision",
      mutationAuthorized: true,
    });
  }

  return authorizationResult(input, evaluation);
}

function invalidCredentialResult(
  input: PreMutationMovementInput,
  evaluation: PreMutationEvaluation,
): PreMutationMovementResult {
  if (input.mode === "noninteractive") {
    return blocked(
      evaluation,
      "hosting.input-invalid",
      "Configured credential sources failed validation; noninteractive deployment cannot prompt for repair.",
    );
  }

  switch (input.invalidCredentialDecision) {
    case undefined:
      return needsInput(evaluation, "repair-credentials");
    case "repair-source":
    case "masked-entry":
      return needsInput(evaluation, "repair-credentials");
    case "skip-optional":
      if (input.invalidCredentialScope !== "optional-only") {
        return blocked(
          evaluation,
          "hosting.input-invalid",
          "A required credential source cannot be skipped as optional.",
        );
      }
      return evaluatePreMutationMovement({ ...input, credentialSourcesValid: true });
    case "exit":
      return cancelled(evaluation, "Credential repair was cancelled before mutation.");
  }
}

function resolveCoreGap(
  input: PreMutationMovementInput,
  neutralEvaluation: PreMutationEvaluation,
): PreMutationMovementResult | undefined {
  const hasCoreGap = neutralEvaluation.notices.some(
    (item) => item.code === "hosting.core-capability-missing",
  );
  if (!hasCoreGap) {
    return neutralEvaluation.outcome === "blocked"
      ? fromEvaluation(neutralEvaluation, {
          outcome: "blocked",
          nextAction: "none",
          mutationAuthorized: false,
        })
      : undefined;
  }

  if (neutralEvaluation.outcome !== "blocked") {
    return undefined;
  }

  if (input.mode === "noninteractive") {
    return input.allowCoreDegraded
      ? undefined
      : fromEvaluation(neutralEvaluation, {
          outcome: "blocked",
          nextAction: "none",
          mutationAuthorized: false,
        });
  }

  switch (input.coreGapDecision) {
    case undefined:
      return needsInput(neutralEvaluation, "choose-core-gap-action");
    case "add-key":
      return needsInput(neutralEvaluation, "repair-credentials");
    case "accept-core-degraded":
      return undefined;
    case "exit":
      return cancelled(neutralEvaluation, "Core degradation was not accepted.");
  }
}

function authorizationResult(
  input: PreMutationMovementInput,
  evaluation: PreMutationEvaluation,
): PreMutationMovementResult {
  if (input.authorization === "pending") {
    return fromEvaluation(
      evaluation,
      {
        outcome: "requires-authorization",
        nextAction: "authorize-host",
        mutationAuthorized: false,
      },
      [
        ...evaluation.notices,
        notice(
          "blocking",
          "hosting.authorization-required",
          "Host authorization is required before deployment can continue.",
        ),
      ],
    );
  }

  if (input.authorizationFailureDecision === undefined) {
    return input.mode === "tty"
      ? needsInput(evaluation, "choose-authorization-recovery")
      : fromEvaluation(
          evaluation,
          { outcome: "blocked", nextAction: "none", mutationAuthorized: false },
          [
            ...evaluation.notices,
            notice(
              "blocking",
              "hosting.authorization-required",
              "Host authorization failed; provide an explicit retry, backend switch, or exit decision.",
            ),
          ],
        );
  }

  switch (input.authorizationFailureDecision) {
    case "retry":
      return fromEvaluation(
        evaluation,
        {
          outcome: "requires-authorization",
          nextAction: "authorize-host",
          mutationAuthorized: false,
        },
        [
          ...evaluation.notices,
          notice(
            "blocking",
            "hosting.authorization-required",
            "Host authorization must be retried before deployment can continue.",
          ),
        ],
      );
    case "switch-backend":
      if (
        input.switchBackendTo === undefined ||
        input.switchBackendTo === input.backend
      ) {
        return input.mode === "tty"
          ? needsInput(evaluation, "choose-backend")
          : blocked(
              evaluation,
              "hosting.input-invalid",
              "Switching backends requires a different explicit supported backend.",
            );
      }
      return {
        ...fromEvaluation(evaluation, {
          outcome: "requires-replan",
          nextAction: "restart-backend-plan",
          mutationAuthorized: false,
        }),
        restartBackend: input.switchBackendTo,
      };
    case "exit":
      return cancelled(evaluation, "Host authorization recovery was cancelled.");
  }
}
