export const boardLiveToolExtension = {
  appId: "nautilo-board",
  mode: "direct_mutation",
  liveToolIds: ["inspect-open-board", "edit-open-board"],
  taskDelegation: { mode: "direct_only" },
  directMutationToolIds: ["edit-open-board"],
  hostOwnsSessionBinding: true,
  hostOwnsIdempotencyKey: true,
  guidance: "Inspect the complete open Board or exact selected object ids, then copy versionToken to expectedVersion. The host owns the active document binding and idempotency. One JSON Patch batch is validated completely and saved once; stale versions are refused.",
} as const;

export type BoardLiveToolExtension = typeof boardLiveToolExtension;
