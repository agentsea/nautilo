export type ScrollRecoveryArgs = {
  requestId: number;
  attemptedRequestId: number | null;
  index: number;
  averageItemLength: number;
  scrollToOffset(offset: number): void;
  scrollToIndex(index: number): void;
  schedule(run: () => void): void;
  fail(): void;
};

/** One measurement-based retry per exact target request, then fail visibly. */
export function recoverTargetScroll(args: ScrollRecoveryArgs): number {
  if (args.attemptedRequestId === args.requestId) {
    args.fail();
    return args.requestId;
  }
  args.scrollToOffset(Math.max(0, args.averageItemLength * args.index));
  args.schedule(() => {
    try {
      args.scrollToIndex(args.index);
    } catch {
      args.fail();
    }
  });
  return args.requestId;
}
