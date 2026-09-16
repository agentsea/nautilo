import type {
  EncryptedCheckpointMaintenanceOutcome,
  EncryptedCheckpointSaver,
  EncryptedCheckpointSaverCloseOutcome,
} from "@nautilo/agent";

export type ProtectedCheckpointSaverDisposalReport = Readonly<{
  primaryErrorPresent: boolean;
  maintenanceOutcomes: readonly EncryptedCheckpointMaintenanceOutcome[];
  close: EncryptedCheckpointSaverCloseOutcome;
}>;

export type ProtectedCheckpointSaverDisposalReporter = (
  report: ProtectedCheckpointSaverDisposalReport,
) => void;

function defaultReporter(
  report: ProtectedCheckpointSaverDisposalReport,
): void {
  const failed = report.maintenanceOutcomes.filter(
    (outcome) => outcome.status === "failed",
  ).length;
  if (
    failed === 0
    && report.close.status === "closed"
    && report.close.pendingMaintenanceCount === 0
  ) {
    return;
  }
  console.warn(
    "[checkpoint] protected saver disposal "
      + `primary_error=${report.primaryErrorPresent ? "present" : "absent"} `
      + `maintenance_failures=${failed} `
      + `pending_maintenance=${report.close.pendingMaintenanceCount} `
      + `close=${report.close.status}`,
  );
}

/**
 * Non-masking protected saver disposal.
 *
 * A durable graph result and checkpoint maintenance are separate facts. This
 * boundary drains the typed post-put maintenance channel, makes one explicit
 * retry under fresh authority, closes the invocation pool, and reports the
 * aggregate without ever throwing over the graph's primary success/failure.
 */
export async function disposeProtectedCheckpointSaver(input: Readonly<{
  saver: EncryptedCheckpointSaver;
  primaryErrorPresent: boolean;
  report?: ProtectedCheckpointSaverDisposalReporter;
}>): Promise<ProtectedCheckpointSaverDisposalReport> {
  const maintenanceOutcomes = [
    ...input.saver.takeMaintenanceOutcomes(),
  ];
  let retryFailure: unknown = null;
  try {
    await input.saver.retryPendingMaintenance();
    maintenanceOutcomes.push(...input.saver.takeMaintenanceOutcomes());
  } catch (cause) {
    retryFailure = cause;
  }

  let close: EncryptedCheckpointSaverCloseOutcome;
  try {
    close = await input.saver.end();
  } catch (cause) {
    close = Object.freeze({
      status: "close_failed",
      pendingMaintenanceCount: input.saver.pendingMaintenanceCount,
      error: new Error("encrypted checkpoint saver close failed", {
        cause,
      }),
    });
  }
  if (retryFailure !== null && close.status === "closed") {
    close = Object.freeze({
      status: "close_failed",
      pendingMaintenanceCount: close.pendingMaintenanceCount,
      error: new Error(
        "encrypted checkpoint maintenance retry could not start",
        { cause: retryFailure },
      ),
    });
  } else if (
    retryFailure !== null
    && close.status === "close_failed"
  ) {
    close = Object.freeze({
      ...close,
      error: new Error("encrypted checkpoint saver disposal failed", {
        cause: new AggregateError(
          [retryFailure, close.error],
          "maintenance retry and saver close failed",
        ),
      }),
    });
  }
  const report = Object.freeze({
    primaryErrorPresent: input.primaryErrorPresent,
    maintenanceOutcomes: Object.freeze(maintenanceOutcomes),
    close,
  });
  try {
    (input.report ?? defaultReporter)(report);
  } catch {
    // Observability cannot change graph truth.
  }
  return report;
}
