import type { SourceAlarmReview } from "../src/node/source-alarm-review";

const MANAGER = "packages/runtime/src/job-manager.ts#log_emitter:";
const JOB = "packages/runtime/src/job.ts#log_emitter:";
// Preserve the existing diagnostic classifications as callsite ordinals move.
const RELOCATIONS = new Map<string, string>([
  ...[[4, 6], [5, 8], [6, 9], [7, 10], [8, 11], [9, 12], [10, 13]].map(([from, to]) =>
    [`${MANAGER}7ef703451e44cded:${from}`, `${MANAGER}7ef703451e44cded:${to}`] as const),
  ...[12, 13, 14, 15, 16, 17, 18, 19].map(from =>
    [`${MANAGER}0ae25e725db4e950:${from}`, `${MANAGER}0ae25e725db4e950:${from - 1}`] as const),
  [`${JOB}d7b5f728bf9d919d:1`, `${JOB}5638279d6b05613a:1`],
]);
const REPLACED_DISPATCH = `${MANAGER}0ae25e725db4e950:11`;
const FIXED_DIAGNOSTICS = [
  ...[4, 5, 7, 14].map(ordinal => `${MANAGER}7ef703451e44cded:${ordinal}`),
  `${MANAGER}26bf1110214d2da4:1`,
  `${JOB}7ef703451e44cded:1`,
  `${JOB}225f5b4012e7f810:1`,
] as const;

/** Review only the changed external-execution callsites, preserving ordinary
 * plaintext diagnostic debt and refusing an unexpected predecessor inventory. */
export function reviewedExternalRoomSourceAlarms(reviews: readonly SourceAlarmReview[]): readonly SourceAlarmReview[] {
  for (const locator of [...RELOCATIONS.keys(), REPLACED_DISPATCH]) {
    if (reviews.filter(review => review.locator === locator).length !== 1) {
      throw new Error(`External execution source review predecessor mismatch: ${locator}`);
    }
  }
  return [
    ...reviews.filter(review => review.locator !== REPLACED_DISPATCH).map(review => ({
      ...review, locator: RELOCATIONS.get(review.locator) ?? review.locator,
    })),
    ...FIXED_DIAGNOSTICS.map((locator, index): SourceAlarmReview => ({
      locator, owner: "packages/runtime", closure: "reviewed_exclusion",
      exclusionId: `exclusion.external-room.execution-observation-${index + 1}`,
      reason: "This exact external-execution diagnostic emits a fixed lifecycle or retry label. The dispatch alternative retains only an opaque protected Job identifier and fixed code. No provider text, generated reply, sender label, claim token, credential, key or caught error payload is interpolated; ordinary diagnostic boundaries remain separately classified.",
    })),
    {
      locator: "packages/agent/src/utils/chat-model-invocation.ts#log_emitter:7ef703451e44cded:13",
      owner: "packages/agent", closure: "reviewed_exclusion",
      exclusionId: "exclusion.external-room.provider-failure-category",
      reason: "The trusted funding session selects content-private diagnostics for external turns regardless of payer kind. This exact call emits only the model coordinate, closed failure category and retryable boolean, never the provider exception message or payload. The shared model cooldown also receives the category only; the separate ordinary-provider raw-error branch retains its existing classification.",
    },
  ];
}
