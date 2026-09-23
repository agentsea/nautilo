export function ownsSubmittedComposerPresentation(input: {
  readonly mounted: boolean;
  readonly activeRoomId: string | null;
  readonly submittedRoomId: string | null;
}): boolean {
  return input.mounted && input.activeRoomId === input.submittedRoomId;
}

export async function sendIfComposerPresentationCurrent(input: {
  readonly isMounted: () => boolean;
  readonly getActiveRoomId: () => string | null;
  readonly submittedRoomId: string | null;
  readonly send: () => Promise<boolean>;
}): Promise<boolean> {
  if (!ownsSubmittedComposerPresentation({
    mounted: input.isMounted(),
    activeRoomId: input.getActiveRoomId(),
    submittedRoomId: input.submittedRoomId,
  })) {
    return false;
  }
  return input.send();
}
