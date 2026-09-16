export const presentationLiveToolExtension = {
  appId: "nautilo-presentation",
  mode: "direct_mutation",
  liveToolIds: ["inspect-open-presentation", "edit-open-presentation", "save-open-template"],
  taskDelegation: { mode: "direct_only" },
  directMutationToolIds: ["edit-open-presentation"],
  hostOwnsSessionBinding: true,
  hostOwnsIdempotencyKey: true,
  guidance:
    "Inspect the open presentation and follow its version-bound continuation before editing. Copy versionToken to expectedVersion. The host owns document binding and idempotency. Document mutations apply as one atomic batch and stale versions are refused. Schema discovery and native patch editing support the full model. save-open-template captures the inspected canonical slide into the private library without changing the source.",
} as const;
export type PresentationLiveToolExtension =
  typeof presentationLiveToolExtension;
