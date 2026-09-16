/**
 * Move any new native Share payload into durable custody, then check durable
 * custody even when native staging had nothing new to report.
 *
 * The second step is what restores a review after process death: the native
 * receipt was already acknowledged before the process died, while the scoped
 * SecureStore receipt remains the authority for resuming the review screen.
 */
export async function resumeShareReview(
  stageNativeShare: () => Promise<boolean>,
  openPendingShare: () => Promise<void>,
): Promise<void> {
  await stageNativeShare();
  await openPendingShare();
}
